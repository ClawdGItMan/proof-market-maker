/**
 * Dashboard data gateway (ELO-13).
 *
 * The bot publishes its live state to Supabase for the read-only dashboard, and
 * reads the dashboard's desired kill-switch mode back. Two transports, by design:
 *
 *   - WRITES go through a Supabase **Edge Function** (`dashboard-rpc`) using a
 *     narrow shared secret. The all-powerful service-role key stays INSIDE
 *     Supabase (injected into the function) and never lands on the trading VM
 *     next to the signing key — a leaked bot secret only grants "publish
 *     dashboard rows", not full DB access.
 *   - READS use the public **anon key** straight against PostgREST. RLS already
 *     allows anon SELECT and denies anon writes, so reads need no privilege.
 *
 * Plain `fetch`, no `@supabase/*` dependency in the trading runtime; injectable
 * `fetch` makes every path unit-testable offline.
 */
import type { KillMode } from "./killControl.js";
import type { Side } from "./diff.js";

/** A point-in-time snapshot of bot state the publisher serialises to a row. */
export interface BotSnapshot {
  market: number;
  ts: number;
  /** Control mode actually applied this tick (run/soft/hard). */
  mode: KillMode;
  stale: boolean;
  /** Ms since the last book frame (watchdog), or null if none yet. */
  staleSinceMs: number | null;
  resyncs: number;
  mid: bigint | null;
  bestBid: bigint | null;
  bestAsk: bigint | null;
  netPosition: bigint;
  /** Total PnL marked at mid (µUSDC·lots), or null if the book is one-sided. */
  pnl: bigint | null;
  openOrders: { id: bigint; side: Side; price: bigint; quantity: bigint }[];
}

export interface AuditRow {
  ts: number;
  kind: string;
  market: number;
  id?: string;
  note?: string;
}

/** Desired control mode as published by the dashboard. */
export interface RemoteControl {
  mode: KillMode;
  /** Millis epoch of the dashboard write; monotonic per command. */
  updatedAt: number;
  updatedBy?: string;
}

/** What the bot needs from the dashboard backend. Narrow on purpose (testable). */
export interface DashboardGateway {
  /** Publish the latest state + open-orders snapshot (one privileged write). */
  publishSnapshot(snap: BotSnapshot): Promise<void>;
  appendAudit(rows: AuditRow[]): Promise<void>;
  readControl(market: number): Promise<RemoteControl | null>;
}

/** BigInt is not JSON-native — prices/ids/qtys cross the wire as decimal strings. */
const s = (v: bigint | null): string | null => (v === null ? null : v.toString());

export interface EdgeGatewayOpts {
  url: string;
  /** Public anon key — used only for RLS-guarded reads. */
  anonKey: string;
  /** Shared secret presented to the write Edge Function (server-side .env only). */
  botSecret: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Edge-function-backed gateway. Writes hit `dashboard-rpc` with the bot secret;
 * reads hit PostgREST with the anon key. Built only when SUPABASE_URL + anon key
 * + bot secret are all present; otherwise the bot runs with no gateway and the
 * publisher no-ops.
 */
export class EdgeFunctionGateway implements DashboardGateway {
  private readonly rest: string;
  private readonly fn: string;
  private readonly anonKey: string;
  private readonly botSecret: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: EdgeGatewayOpts) {
    if (!opts.url || !opts.anonKey || !opts.botSecret) {
      throw new Error("EdgeFunctionGateway needs url + anonKey + botSecret");
    }
    const base = opts.url.replace(/\/$/, "");
    this.rest = `${base}/rest/v1`;
    this.fn = `${base}/functions/v1/dashboard-rpc`;
    this.anonKey = opts.anonKey;
    this.botSecret = opts.botSecret;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  /** POST a privileged op to the write Edge Function. */
  private async rpc(op: string, payload: Record<string, unknown>): Promise<void> {
    const res = await this.doFetch(this.fn, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.botSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ op, ...payload }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`dashboard-rpc ${op} -> ${res.status} ${body.slice(0, 200)}`);
    }
  }

  async publishSnapshot(snap: BotSnapshot): Promise<void> {
    const state = {
      market: snap.market,
      ts: snap.ts,
      mode: snap.mode,
      stale: snap.stale,
      stale_since_ms: snap.staleSinceMs,
      resyncs: snap.resyncs,
      mid: s(snap.mid),
      best_bid: s(snap.bestBid),
      best_ask: s(snap.bestAsk),
      net_position: snap.netPosition.toString(),
      pnl: s(snap.pnl),
      open_order_count: snap.openOrders.length,
      heartbeat_at: snap.ts,
    };
    const orders = snap.openOrders.map((o) => ({
      market: snap.market,
      order_id: o.id.toString(),
      side: o.side === 1 ? "buy" : "sell",
      price: o.price.toString(),
      quantity: o.quantity.toString(),
      ts: snap.ts,
    }));
    await this.rpc("publish", { state, orders });
  }

  async appendAudit(rows: AuditRow[]): Promise<void> {
    if (rows.length === 0) return;
    const out = rows.map((r) => ({ ts: r.ts, kind: r.kind, market: r.market, order_id: r.id ?? null, note: r.note ?? null }));
    await this.rpc("audit", { rows: out });
  }

  /** Read the desired control mode via PostgREST with the anon key (RLS allows SELECT). */
  async readControl(market: number): Promise<RemoteControl | null> {
    const res = await this.doFetch(
      `${this.rest}/bot_control?market=eq.${market}&select=mode,updated_at_ms,updated_by&limit=1`,
      { method: "GET", headers: { apikey: this.anonKey, Authorization: `Bearer ${this.anonKey}` } },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`readControl -> ${res.status} ${body.slice(0, 200)}`);
    }
    const rows = (await res.json()) as Array<{ mode: string; updated_at_ms: number | string; updated_by?: string }>;
    const r = rows[0];
    if (!r) return null;
    const mode = r.mode === "soft" || r.mode === "hard" ? (r.mode as KillMode) : "run";
    return { mode, updatedAt: Number(r.updated_at_ms), updatedBy: r.updated_by };
  }
}
