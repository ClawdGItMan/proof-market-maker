// Row shapes as published to Supabase by the bot (see supabase/migrations/0001_dashboard.sql).
// Numeric fields that exceed JS Number safety (prices, sizes, order ids, pnl) cross the wire
// as TEXT decimal strings — the dashboard parses them with BigInt, never Number.

export type KillMode = "run" | "soft" | "hard";

export interface BotStateRow {
  market: number;
  ts: number;
  mode: KillMode;
  stale: boolean;
  stale_since_ms: number | null;
  resyncs: number;
  mid: string | null;
  best_bid: string | null;
  best_ask: string | null;
  net_position: string;
  pnl: string | null;
  open_order_count: number;
  heartbeat_at: number;
  updated_at: string;
}

export interface OpenOrderRow {
  id: number;
  market: number;
  order_id: string;
  side: "buy" | "sell";
  price: string;
  quantity: string;
  ts: number;
}

export interface AuditRow {
  id: number;
  ts: number;
  market: number;
  kind: string;
  order_id: string | null;
  note: string | null;
}

export interface ControlRow {
  market: number;
  mode: KillMode;
  updated_at_ms: number;
  updated_by: string | null;
}

/** Everything one market card needs, assembled server-side. */
export interface MarketView {
  market: number;
  state: BotStateRow | null;
  orders: OpenOrderRow[];
  audit: AuditRow[];
  control: ControlRow | null;
}

export interface DashboardData {
  markets: MarketView[];
  /** Server clock when this snapshot was assembled — used to age the heartbeat client-side. */
  fetchedAt: number;
}
