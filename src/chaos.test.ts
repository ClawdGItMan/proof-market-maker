import { describe, it, expect } from "vitest";
import { MarketMaker, type MarketMakerDeps } from "./bot.js";
import type { ProofAdapter } from "./sdkAdapter.js";
import type { NonceManager } from "./nonceManager.js";
import type { Strategy } from "./strategy.js";
import type { Logger } from "./logger.js";
import type { OrderbookStreamHandlers } from "./orderbookStream.js";
import { StaleWatchdog } from "./staleWatchdog.js";

/**
 * Chaos suite (ELO-15) — recovery paths from ELO-16.
 *
 * These drive a real `MarketMaker` against a fully in-memory adapter so the
 * failure modes are deterministic with no sockets, no clocks, no sleeps:
 *
 *  1. Frozen-feed recovery: a *half-open* socket keeps delivering incremental
 *     updates (feeding the watchdog) but never re-snapshots. The bot must force
 *     a resubscribe so a fresh snapshot lands and quoting resumes — it must not
 *     stay dark forever (ELO-16 #1).
 *  2. Startup orphan verification: a cancel-all that returns success while only
 *     partially clearing must be caught by a re-query, retried, and — if orphans
 *     survive — refused with a throw rather than quoting on top of them
 *     (ELO-16 #2).
 */

const nullLog = (): Logger => {
  const l: Record<string, unknown> = {};
  for (const m of ["info", "warn", "error", "debug"]) l[m] = () => {};
  l.child = () => nullLog();
  return l as unknown as Logger;
};

const okNonce = (): NonceManager => ({ gate: async () => {} } as unknown as NonceManager);

/** Stub strategy: always wants exactly one quote per side, so a live book yields placements. */
const twoSidedStrategy = (): Strategy =>
  ({
    quote: () => [
      { side: 1 as const, price: 99n, quantity: 10n },
      { side: 2 as const, price: 103n, quantity: 10n },
    ],
  } as unknown as Strategy);

interface FakeOrder {
  id: bigint;
  market: number;
  side: "Buy" | "Sell";
  price: bigint;
  quantity: bigint;
}

const snapshot = (market: number) => ({
  type: "snapshot" as const,
  channel: "orderbook" as const,
  market,
  bids: [{ price: 100n, totalQty: 5n, orderCount: 1 }],
  asks: [{ price: 102n, totalQty: 5n, orderCount: 1 }],
});

const updateFrame = (market: number) => ({
  type: "update" as const,
  channel: "orderbook" as const,
  market,
  side: "buy" as const,
  price: 100n,
  totalQuantity: 5n,
  orderCount: 1,
});

/**
 * In-memory adapter. Holds the stream handlers and a mutable resting-order book
 * the executor reads via openOrders() and mutates via place/cancel-all.
 */
class FakeAdapter {
  resting: FakeOrder[] = [];
  handlers: OrderbookStreamHandlers | null = null;
  dropCount = 0;
  cancelAllCalls = 0;
  private pendingReconnect = false;
  private nextId = 1n;

  constructor(
    readonly market: number,
    /** What a cancel-all does to the resting book; defaults to a clean clear (code 0). */
    private readonly onCancelAll: (resting: FakeOrder[]) => { code: number; resting: FakeOrder[] } = (r) => ({
      code: 0,
      resting: [],
    }),
  ) {}

  streamOrderbook(_market: number, h: OrderbookStreamHandlers): () => void {
    this.handlers = h;
    h.onSubscribed?.();
    h.onSocket?.(() => this.forceDrop());
    h.onSnapshot(snapshot(this.market)); // first snapshot → book live
    return () => {};
  }

  /** Model an async drop: tear down now, deliver the fresh snapshot only on completeReconnect(). */
  private forceDrop(): void {
    this.dropCount += 1;
    this.pendingReconnect = true;
    this.handlers?.onReconnect?.(); // marks the book stale
  }

  /** A half-open socket keeps pushing updates (feeding the watchdog) but never re-snapshots. */
  pushUpdate(): void {
    this.handlers?.onUpdate(updateFrame(this.market));
  }

  /** Simulate the reconnect landing: only possible if the bot actually forced a drop. */
  completeReconnect(): boolean {
    if (!this.pendingReconnect) return false;
    this.pendingReconnect = false;
    this.handlers?.onSnapshot(snapshot(this.market)); // fresh snapshot → resync, book live
    return true;
  }

  async openOrders(): Promise<FakeOrder[]> {
    return this.resting;
  }
  async netPosition(): Promise<bigint> {
    return 0n;
  }
  async cancelAllOrdersCommit(_market?: number): Promise<{ code: number }> {
    this.cancelAllCalls += 1;
    const { code, resting } = this.onCancelAll(this.resting);
    this.resting = resting;
    return { code };
  }
  async placeOrderCommit(p: { side: number; price: bigint; quantity: bigint }) {
    const id = this.nextId++;
    this.resting.push({
      id,
      market: this.market,
      side: p.side === 1 ? "Buy" : "Sell",
      price: p.price,
      quantity: p.quantity,
    });
    return { tx: { code: 0, events: [] }, orderId: id };
  }
  async cancelOrderCommit(id: bigint) {
    this.resting = this.resting.filter((o) => o.id !== id);
    return { code: 0 };
  }
  async cancelReplaceCommit() {
    return { tx: { code: 0, events: [] }, orderId: this.nextId++ };
  }
  disconnect(): void {}
}

function buildMM(adapter: FakeAdapter, watchdog?: StaleWatchdog): MarketMaker {
  const deps: MarketMakerDeps = {
    adapter: adapter as unknown as ProofAdapter,
    strategy: twoSidedStrategy(),
    nonce: okNonce(),
    log: nullLog(),
    market: adapter.market,
    watchdog,
  };
  return new MarketMaker(deps);
}

describe("chaos: frozen half-open feed recovery (ELO-16 #1)", () => {
  it("forces a resubscribe and resumes quoting when a half-open socket stops snapshotting", async () => {
    let t = 0;
    const clock = () => t;
    const watchdog = new StaleWatchdog({ thresholdMs: 1_000, now: clock });
    const adapter = new FakeAdapter(1);
    const mm = buildMM(adapter, watchdog);

    await mm.connect();
    // Book live → first tick places two-sided quotes.
    await mm.tick();
    expect(adapter.resting.length).toBe(2);
    expect(mm.isStale()).toBe(false);

    // Feed goes silent past the threshold.
    t += 1_001;
    await mm.tick();
    // Watchdog freeze must mark stale, pull quotes, AND force a socket drop.
    expect(mm.isStale()).toBe(true);
    expect(adapter.dropCount).toBe(1);
    expect(adapter.resting.length).toBe(0);

    // The half-open socket resumes pushing *updates* (feeding the watchdog) but
    // never re-snapshots. The watchdog is no longer frozen — yet without the
    // forced drop the bot would be stranded stale forever.
    t += 1;
    adapter.pushUpdate();
    expect(watchdog.isFrozen()).toBe(false);
    await mm.tick();
    expect(mm.isStale()).toBe(true); // still stale: updates alone don't un-stale us

    // The forced reconnect lands a fresh snapshot → book live again.
    expect(adapter.completeReconnect()).toBe(true);
    expect(mm.isStale()).toBe(false);
    expect(mm.resyncCount).toBe(1);

    // Quoting resumes.
    await mm.tick();
    expect(adapter.resting.length).toBe(2);
  });
});

describe("chaos: startup reconcile verifies orphans are gone (ELO-16 #2)", () => {
  const orphans = (market: number): FakeOrder[] => [
    { id: 1n, market, side: "Buy", price: 99n, quantity: 10n },
    { id: 2n, market, side: "Sell", price: 103n, quantity: 10n },
  ];

  it("retries the cancel-all when it returns success but only partially clears", async () => {
    let call = 0;
    // First cancel-all leaves one order (partial); second clears the rest.
    const adapter = new FakeAdapter(1, (resting) => {
      call += 1;
      return call === 1 ? { code: 0, resting: resting.slice(1) } : { code: 0, resting: [] };
    });
    adapter.resting = orphans(1);
    const mm = buildMM(adapter);

    await expect(mm.reconcileOnStartup()).resolves.toBeUndefined();
    expect(adapter.resting.length).toBe(0);
    expect(adapter.cancelAllCalls).toBe(2);
  });

  it("THROWS rather than quoting when orphans survive every cancel-all", async () => {
    // cancel-all keeps reporting success (code 0) but never actually clears.
    const adapter = new FakeAdapter(1, (resting) => ({ code: 0, resting }));
    adapter.resting = orphans(1);
    const mm = buildMM(adapter);

    await expect(mm.reconcileOnStartup()).rejects.toThrow(/surviv|resting|refus/i);
    expect(adapter.resting.length).toBeGreaterThan(0);
  });
});
