// Server-side read layer. Reads go straight to PostgREST with the public ANON key
// (RLS allows anon SELECT, denies all anon writes — see 0001_dashboard.sql). No
// @supabase/supabase-js dependency: plain fetch keeps the bundle tiny and the data
// shaping in one place.
//
// N+1 guard: regardless of how many markets the bot runs, this assembles the whole
// dashboard in a FIXED 4 reads (state, orders, control, audit) and groups in memory.
// It never issues one query per market.

import type {
  AuditRow,
  BotStateRow,
  ControlRow,
  DashboardData,
  MarketView,
  OpenOrderRow,
} from "./types";

const AUDIT_GLOBAL_LIMIT = 300; // newest events across all markets, sliced to 50/market below
const AUDIT_PER_MARKET = 50;

function env(): { url: string; anon: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are required");
  }
  return { url: url.replace(/\/$/, ""), anon };
}

async function read<T>(path: string): Promise<T[]> {
  const { url, anon } = env();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: anon, Authorization: `Bearer ${anon}` },
    // Always fresh — this is a live ops view, never cache the read.
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`supabase read ${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T[];
}

function groupBy<T>(rows: T[], key: (r: T) => number): Map<number, T[]> {
  const m = new Map<number, T[]>();
  for (const r of rows) {
    const k = key(r);
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/** Assemble the full dashboard in 4 reads. `now` is injected so the value is testable. */
export async function fetchDashboard(now: number): Promise<DashboardData> {
  const [states, orders, controls] = await Promise.all([
    read<BotStateRow>("bot_state?select=*&order=market.asc"),
    read<OpenOrderRow>("open_orders?select=*&order=market.asc,side.asc,price.asc"),
    read<ControlRow>("bot_control?select=*"),
  ]);

  // Filter requested markets if DASHBOARD_MARKETS is set; else show every published market.
  const allow = (process.env.DASHBOARD_MARKETS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const markets = new Set<number>(
    allow.length > 0 ? allow : states.map((s) => s.market),
  );

  // One audit read, newest-first, restricted to the shown markets, then sliced per market.
  const marketList = [...markets];
  const audit =
    marketList.length > 0
      ? await read<AuditRow>(
          `audit_log?select=*&market=in.(${marketList.join(",")})&order=ts.desc&limit=${AUDIT_GLOBAL_LIMIT}`,
        )
      : [];

  const ordersByMarket = groupBy(orders, (o) => o.market);
  const auditByMarket = groupBy(audit, (a) => a.market);
  const stateByMarket = new Map(states.map((s) => [s.market, s]));
  const controlByMarket = new Map(controls.map((c) => [c.market, c]));

  const views: MarketView[] = marketList
    .sort((a, b) => a - b)
    .map((market) => ({
      market,
      state: stateByMarket.get(market) ?? null,
      orders: ordersByMarket.get(market) ?? [],
      audit: (auditByMarket.get(market) ?? []).slice(0, AUDIT_PER_MARKET),
      control: controlByMarket.get(market) ?? null,
    }));

  return { markets: views, fetchedAt: now };
}
