/**
 * Market-maker runtime: wires the stream → local book → strategy → diff →
 * executor into a single quoting loop, with stale/resync gating.
 *
 * Resync behaviour (the ELO-9 done-criterion): when the socket drops, the book
 * is marked **stale**, the bot pulls all quotes once (kill-switch) and stops
 * quoting; when the re-subscribe delivers a fresh snapshot the book is live
 * again and quoting resumes. A maker quoting off a stale book is how you get
 * picked off, so pulling on staleness is the safe behaviour, not just a nicety.
 *
 * The `MarketMaker` class is reused by `demoResync.ts`, which drives ticks
 * manually and forces a socket drop to prove clean recovery.
 */
import { loadConfig } from "./config.js";
import { ProofAdapter } from "./sdkAdapter.js";
import { NonceManager, FileNonceStore } from "./nonceManager.js";
import { OrderTracker } from "./orderTracker.js";
import { Executor } from "./executor.js";
import { LocalBook } from "./book.js";
import { diffQuotes, type RestingOrder, type Side } from "./diff.js";
import { FixedSpreadStrategy, type Strategy, type MarketView } from "./strategy.js";
import { createLogger, type Logger } from "./logger.js";
import { KillControl } from "./killControl.js";
import { StaleWatchdog } from "./staleWatchdog.js";
import { Journal, findOrphans } from "./journal.js";
import { TokenBucket } from "./tokenBucket.js";
import { PnlAccumulator } from "./pnl.js";
import { BotStatePublisher } from "./publisher.js";
import { ControlBridge } from "./controlBridge.js";
import { EdgeFunctionGateway, type BotSnapshot, type AuditRow } from "./dashboardGateway.js";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

export interface MarketMakerDeps {
  adapter: ProofAdapter;
  strategy: Strategy;
  nonce: NonceManager;
  log: Logger;
  market: number;
  /** Requote price tolerance in bps of mid — below this drift we leave quotes alone (anti-churn). */
  requoteTolBps?: bigint;
  /** Two-tier kill-switch control file (run / soft / hard). Optional: omit to always run. */
  killControl?: KillControl;
  /** Frozen-feed watchdog: silent-socket detection beyond the explicit-drop path. Optional. */
  watchdog?: StaleWatchdog;
  /** Crash-recovery journal of order intents. Optional. */
  journal?: Journal;
  /** Rate-limit throttle for order submission. Optional. */
  bucket?: TokenBucket;
  /** Dashboard state publisher (best-effort, never breaks a tick). Optional. */
  publisher?: BotStatePublisher;
  /** Dashboard→bot control bridge (mirrors desired mode to the control file). Optional. */
  controlBridge?: ControlBridge;
}

export class MarketMaker {
  private readonly book = new LocalBook();
  private readonly tracker = new OrderTracker();
  private readonly executor: Executor;
  private stale = true;
  private snapshots = 0;
  private resyncs = 0;
  private unsub: (() => void) | null = null;
  private forceDrop: (() => void) | null = null;
  private stopped = false;
  private pulling = false;
  private hardPulled = false;
  // Cached for the (best-effort) dashboard snapshot, so publishing reuses the
  // tick's reads instead of issuing extra network calls (no publish-side N+1).
  private readonly pnl = new PnlAccumulator();
  private lastNet = 0n;
  private lastResting: RestingOrder[] = [];

  constructor(private readonly deps: MarketMakerDeps) {
    this.executor = new Executor({
      adapter: deps.adapter,
      nonce: deps.nonce,
      tracker: this.tracker,
      log: deps.log,
      market: deps.market,
      bucket: deps.bucket,
    });
  }

  /** Start the stream; resolve once the first snapshot lands (book live). */
  async connect(timeoutMs = 8_000): Promise<void> {
    this.unsub = this.deps.adapter.streamOrderbook(this.deps.market, {
      onSubscribed: () => this.deps.log.debug("ws subscribed"),
      onSnapshot: (s) => {
        this.deps.watchdog?.feed();
        this.book.applySnapshot(s);
        this.snapshots += 1;
        if (this.snapshots > 1) this.resyncs += 1;
        this.stale = false;
        this.deps.log.info(
          { snapshots: this.snapshots, bids: s.bids.length, asks: s.asks.length },
          this.snapshots > 1 ? "resynced" : "book live",
        );
      },
      onUpdate: (u) => {
        this.deps.watchdog?.feed();
        if (!this.stale) this.book.applyUpdate(u);
      },
      onReconnect: () => {
        this.stale = true;
        this.deps.log.warn("socket dropped — book stale, pulling quotes until resync");
      },
      onError: (e) => this.deps.log.warn({ err: String(e) }, "ws error"),
      onSocket: (drop) => {
        this.forceDrop = drop;
      },
    });
    await waitUntil(() => this.snapshots > 0, timeoutMs, "first orderbook snapshot");
  }

  private marketView(): MarketView {
    const bb = this.book.bestBid();
    const ba = this.book.bestAsk();
    const bid = bb?.price ?? null;
    const ask = ba?.price ?? null;
    const mid = bid !== null && ask !== null ? (bid + ask) / 2n : null;
    return { bestBid: bid, bestAsk: ask, mid };
  }

  /** Resting orders for our market, from the exchange (source of truth). */
  private async restingOrders(): Promise<RestingOrder[]> {
    const open = await this.deps.adapter.openOrders();
    return open
      .filter((o) => o.market === this.deps.market)
      .map((o) => ({ id: o.id, side: (o.side === "Buy" ? 1 : 2) as Side, price: o.price, quantity: o.quantity }));
  }

  /** One MM iteration: honour the kill-switch, reconcile fills, then (if live) requote. */
  async tick(): Promise<void> {
    if (this.stopped) return;

    // Pull the dashboard's desired mode into the local control file BEFORE we
    // read it, so a button click on the dashboard lands within this same tick.
    // Best-effort: a cloud/network failure leaves the local file authoritative.
    await this.deps.controlBridge?.poll();

    // Two-tier kill-switch (local control file). HARD wins over everything.
    const mode = this.deps.killControl?.read() ?? "run";
    if (mode === "hard") {
      if (!this.hardPulled) {
        this.hardPulled = true;
        this.deps.log.warn("HARD kill-switch — cancel-all then idle until cleared");
        this.deps.journal?.append({ ts: Date.now(), kind: "cancelAll", note: "hard-kill" });
        await this.deps.publisher?.audit([{ ts: Date.now(), kind: "control", market: this.deps.market, note: "hard-kill: cancel-all" }]);
        try {
          await this.executor.killSwitch();
        } catch (e) {
          this.deps.log.error({ err: String(e) }, "hard-kill cancel-all failed");
        }
      }
      return; // idle in-process so the supervisor doesn't thrash-restart us
    }
    this.hardPulled = false; // cleared → re-arm for a future hard pull

    // Frozen-feed detection: a silent (still-open) socket is as dangerous as a
    // dropped one, so treat a frozen book exactly like a drop — go stale + pull.
    //
    // Marking stale is not enough on its own: `stale` only clears on a fresh
    // snapshot, but a half-open socket can silently resume pushing *incremental*
    // updates (each calls watchdog.feed(), so isFrozen() flips back to false)
    // without ever re-snapshotting — leaving the bot stale, dark, and unable to
    // recover. So on the freeze we also force a socket drop, which kicks the
    // reconnect path to re-subscribe and deliver a fresh snapshot that clears the
    // stale flag. The `!stale` guard makes this fire once per freeze episode (not
    // every tick), since stale stays set until that fresh snapshot lands.
    if (!this.stale && this.deps.watchdog?.isFrozen()) {
      this.stale = true;
      this.deps.log.warn(
        { sinceMs: this.deps.watchdog.sinceLast },
        "book frozen (watchdog) — stale, pulling quotes and forcing resubscribe",
      );
      this.forceSocketDrop();
    }

    const resting = await this.restingOrders();
    this.lastResting = resting;
    const audits: AuditRow[] = [];
    for (const f of this.tracker.reconcile(resting).fills) {
      this.pnl.onFill(f.side, f.price, f.quantity);
      this.deps.journal?.append({ ts: Date.now(), kind: "fill", id: String(f.id) });
      audits.push({ ts: Date.now(), kind: "fill", market: this.deps.market, id: String(f.id) });
      this.deps.log.info({ id: f.id, side: f.side, price: f.price, qty: f.quantity }, "inferred fill");
    }
    await this.deps.publisher?.audit(audits); // mirror fills to the dashboard audit log

    if (this.stale) {
      // Book unreliable after a drop/freeze: pull all quotes once, then wait for resync.
      if (resting.length > 0 && !this.pulling) {
        this.pulling = true;
        try {
          await this.executor.killSwitch();
        } finally {
          this.pulling = false;
        }
      }
      return;
    }

    if (mode === "soft") {
      // Pause: keep resting orders and keep reconciling fills, but place nothing new.
      return;
    }

    const view = this.marketView();
    if (view.mid === null) {
      this.deps.log.debug("book one-sided — skipping quote");
      return;
    }
    const net = await this.deps.adapter.netPosition(this.deps.market);
    this.lastNet = net;
    const desired = this.deps.strategy.quote(view, { net });
    const tolBps = this.deps.requoteTolBps ?? 2n;
    const priceTolerance = (view.mid * tolBps) / 10_000n;
    const actions = diffQuotes(desired, resting, { priceTolerance });
    if (actions.length > 0) {
      this.deps.log.info(
        { mid: view.mid, net, bid: view.bestBid, ask: view.bestAsk, desired: desired.length, actions: actions.length },
        "requote",
      );
    }
    await this.executor.apply(actions);
  }

  /**
   * Build + publish a state snapshot for the dashboard. Runs every tick from
   * runLoop (after tick()), so the dashboard sees a fresh heartbeat regardless
   * of which mode/early-return path the tick took. Reuses the tick's cached
   * reads (no extra network calls); the publisher itself swallows failures.
   */
  private async publishState(): Promise<void> {
    if (!this.deps.publisher) return;
    const view = this.marketView();
    const snap: BotSnapshot = {
      market: this.deps.market,
      ts: Date.now(),
      mode: this.deps.killControl?.read() ?? "run",
      stale: this.stale,
      staleSinceMs: this.deps.watchdog?.sinceLast ?? null,
      resyncs: this.resyncs,
      mid: view.mid,
      bestBid: view.bestBid,
      bestAsk: view.bestAsk,
      netPosition: this.lastNet,
      pnl: this.pnl.pnl(view.mid),
      openOrders: this.lastResting.map((o) => ({ id: o.id, side: o.side, price: o.price, quantity: o.quantity })),
    };
    await this.deps.publisher.publishTick(snap);
  }

  /** Continuous quoting loop until stopped. */
  async runLoop(intervalMs: number): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick();
        await this.publishState();
      } catch (e) {
        this.deps.log.error({ err: String(e) }, "tick error");
      }
      await sleep(intervalMs);
    }
  }

  /**
   * Crash-recovery: before quoting, cancel any resting order the bot does not
   * recognise. On a cold restart the in-memory tracker is empty, so every order
   * the exchange still holds for us is an orphan and gets pulled — a clean slate,
   * the guarantee the chaos tests check ("kill process → no orphan orders").
   */
  async reconcileOnStartup(): Promise<void> {
    this.deps.journal?.append({ ts: Date.now(), kind: "boot" });
    const resting = await this.restingOrders();
    const known = new Set(resting.filter((o) => this.tracker.byId(o.id)).map((o) => o.id.toString()));
    const orphans = findOrphans(resting.map((o) => o.id), known);
    if (orphans.length === 0) {
      this.deps.log.info({ resting: resting.length }, "startup reconcile — no orphans");
      return;
    }
    this.deps.log.warn({ orphans: orphans.length }, "startup reconcile — cancelling orphan orders");
    this.deps.journal?.append({ ts: Date.now(), kind: "cancelAll", note: "startup-orphans" });

    // A cancel-all that *throws* is already handled (executor.killSwitch rejects
    // on a non-zero code — ELO-10). But a cancel-all can also return success
    // (code 0) while only *partially* clearing the book; quoting on top of a
    // surviving orphan is the exact crash-recovery failure this guards against.
    // So we re-query the exchange (source of truth) after each cancel and only
    // return once it proves zero resting orders, retrying a bounded number of
    // times before refusing to quote.
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.executor.killSwitch(); // single atomic cancel-all on our market
      const remaining = await this.restingOrders();
      if (remaining.length === 0) {
        this.deps.log.info({ attempts: attempt }, "startup reconcile — verified zero resting orders before quoting");
        return;
      }
      this.deps.log.warn(
        { remaining: remaining.length, attempt, maxAttempts },
        "startup reconcile — orders survived cancel-all; retrying",
      );
    }
    throw new Error(
      `startup reconcile: resting orders survived ${maxAttempts} cancel-all attempts — refusing to quote on top of orphans`,
    );
  }

  /** Force-close the live socket to exercise the resync path (demo/drills). */
  forceSocketDrop(): void {
    this.forceDrop?.();
  }
  get resyncCount(): number {
    return this.resyncs;
  }
  isStale(): boolean {
    return this.stale;
  }
  /** Resolve once a resync beyond `prev` has completed and the book is live. */
  async waitForResync(prev: number, timeoutMs = 20_000): Promise<void> {
    await waitUntil(() => this.resyncs > prev && !this.stale, timeoutMs, "orderbook resync");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsub?.();
    try {
      await this.executor.killSwitch();
    } catch {
      /* best-effort flatten on shutdown */
    }
    this.deps.adapter.disconnect();
  }
}

/** Build a MarketMaker from env config + a fixed-spread strategy. */
export function buildMarketMaker(market: number): { mm: MarketMaker; log: Logger; adapter: ProofAdapter } {
  const cfg = loadConfig();
  const log = createLogger(cfg).child({ market });
  const adapter = new ProofAdapter(cfg);
  const num = (k: string, d: bigint): bigint => {
    const v = process.env[k];
    return v && /^\d+$/.test(v) ? BigInt(v) : d;
  };
  const strategy = new FixedSpreadStrategy({
    spreadBps: num("MM_SPREAD_BPS", 10n),
    quoteSize: num("MM_QUOTE_SIZE", 160n),
    maxInventory: num("MM_MAX_INVENTORY", 800n),
    inventorySkewBps: num("MM_SKEW_BPS", 5n),
    tickSize: 0n, // devnet enforces no tick gate (ELO-8); strategy rounds to 1µ steps
  });
  const nonce = new NonceManager({ store: new FileNonceStore("data/nonce.state") });
  const numEnv = (k: string, d: number): number => {
    const v = process.env[k];
    return v && /^\d+$/.test(v) ? Number(v) : d;
  };
  const killControl = new KillControl(process.env.MM_CONTROL_FILE ?? "data/control");
  const watchdog = new StaleWatchdog({ thresholdMs: numEnv("MM_STALE_MS", 15_000) });
  const journal = new Journal(process.env.MM_JOURNAL ?? "data/journal.jsonl");
  const bucket = new TokenBucket({
    capacity: numEnv("MM_RATE_BURST", 8),
    refillPerSec: numEnv("MM_RATE_PER_SEC", 4),
  });

  // Dashboard publishing + control bridge are wired ONLY when Supabase is
  // configured. Writes go through the dashboard-rpc Edge Function with a narrow
  // shared secret (BOT_PUBLISH_SECRET); the master service-role key never touches
  // this host. Absent any of the three → the bot runs exactly as before with no
  // dashboard coupling (the deps stay undefined).
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const botSecret = process.env.BOT_PUBLISH_SECRET;
  let publisher: BotStatePublisher | undefined;
  let controlBridge: ControlBridge | undefined;
  if (supabaseUrl && anonKey && botSecret) {
    const gateway = new EdgeFunctionGateway({ url: supabaseUrl, anonKey, botSecret });
    publisher = new BotStatePublisher(gateway, log);
    controlBridge = new ControlBridge(gateway, killControl, market, log);
    log.info({ market }, "dashboard publishing enabled (Supabase Edge Function)");
  }

  const mm = new MarketMaker({ adapter, strategy, nonce, log, market, killControl, watchdog, journal, bucket, publisher, controlBridge });
  return { mm, log, adapter };
}

/** CLI entrypoint: quote both sides until SIGINT/SIGTERM, then flatten. */
async function main(): Promise<void> {
  const market = Number(process.argv[2] ?? process.env.MM_MARKET ?? 1);
  const requoteMs = Number(process.env.MM_REQUOTE_MS ?? 3_000);
  const { mm, log } = buildMarketMaker(market);

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn({ sig }, "shutting down — flattening quotes");
    await mm.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  log.info({ requoteMs }, "connecting…");
  await mm.connect();
  await mm.reconcileOnStartup(); // crash-recovery: pull orphan orders before quoting
  log.info("two-sided quoting started");
  await mm.runLoop(requoteMs);
}

// Run only when invoked directly (not when imported by the demo).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("[bot] fatal:", e);
    process.exit(1);
  });
}
