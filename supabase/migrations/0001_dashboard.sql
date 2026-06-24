-- ELO-13 read-only ops dashboard schema.
--
-- Trust model (CLAUDE.md non-negotiables: RLS on every table; secrets env-only):
--   * The BOT writes every table using the SERVICE-ROLE key (server-side, env
--     only). The service role bypasses RLS, so the bot's writes always succeed.
--   * The DASHBOARD browser uses the ANON key. RLS below grants anon SELECT on
--     the observable tables and DENIES anon writes everywhere. The only write the
--     dashboard performs is on `bot_control`, and it does so server-side (Next.js
--     server action) with the service-role key — never from the browser.
--   * PROOF_PRIVATE_KEY lives only in the bot's .env and never touches Supabase.
--
-- Numeric note: prices / sizes / order ids are BigInt (µUSDC, integer lots,
-- u64 ids) and exceed JS Number / int8 safety, so they are stored as TEXT
-- decimal strings — the same representation the bot serialises on the wire.

-- ---------------------------------------------------------------------------
-- bot_state: one latest-snapshot row per market (upserted every tick).
-- ---------------------------------------------------------------------------
create table if not exists public.bot_state (
  market            integer primary key,
  ts                bigint  not null,         -- snapshot millis epoch
  mode              text    not null check (mode in ('run','soft','hard')),
  stale             boolean not null default false,
  stale_since_ms    bigint,                   -- watchdog sinceLast, null = fresh/none
  resyncs           integer not null default 0,
  mid               text,                     -- µUSDC, null if one-sided
  best_bid          text,
  best_ask          text,
  net_position      text    not null default '0',
  pnl               text,                     -- µUSDC·lots marked at mid, null if one-sided
  open_order_count  integer not null default 0,
  heartbeat_at      bigint  not null,         -- liveness: dashboard flags stale if old
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- open_orders: current resting orders per market (replace-on-publish).
-- ---------------------------------------------------------------------------
create table if not exists public.open_orders (
  id        bigint generated always as identity primary key,
  market    integer not null,
  order_id  text    not null,
  side      text    not null check (side in ('buy','sell')),
  price     text    not null,
  quantity  text    not null,
  ts        bigint  not null
);
create index if not exists open_orders_market_idx on public.open_orders (market);

-- ---------------------------------------------------------------------------
-- audit_log: append-only event stream (mirrors the bot's crash journal).
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id        bigint generated always as identity primary key,
  ts        bigint  not null,
  market    integer not null,
  kind      text    not null,                 -- place|cancel|cancelAll|fill|boot|control
  order_id  text,
  note      text,
  created_at timestamptz not null default now()
);
-- Hot query is "latest events for a market" — index supports it (no N+1 scans).
create index if not exists audit_log_market_ts_idx on public.audit_log (market, ts desc);

-- ---------------------------------------------------------------------------
-- bot_control: desired kill-switch mode the dashboard writes; the bot mirrors
-- it into its LOCAL control file (see src/controlBridge.ts). updated_at_ms is a
-- monotonic command stamp the bridge uses to apply only *fresh* commands.
-- ---------------------------------------------------------------------------
create table if not exists public.bot_control (
  market         integer primary key,
  mode           text    not null check (mode in ('run','soft','hard')),
  updated_at_ms  bigint  not null,
  updated_by     text,
  updated_at     timestamptz not null default now()
);

-- ===========================================================================
-- RLS — enabled on EVERY table; anon may read the observable ones, write none.
-- (The service role used by the bot + the dashboard server action bypasses RLS.)
-- ===========================================================================
alter table public.bot_state   enable row level security;
alter table public.open_orders enable row level security;
alter table public.audit_log   enable row level security;
alter table public.bot_control enable row level security;

-- Read-only dashboard: anon + authenticated may SELECT state/orders/audit.
create policy "read bot_state"   on public.bot_state   for select to anon, authenticated using (true);
create policy "read open_orders" on public.open_orders for select to anon, authenticated using (true);
create policy "read audit_log"   on public.audit_log   for select to anon, authenticated using (true);
-- bot_control is readable too (so the UI can show the current desired mode),
-- but NOT writable by anon — the control write goes through the server action.
create policy "read bot_control" on public.bot_control for select to anon, authenticated using (true);

-- No INSERT/UPDATE/DELETE policies for anon/authenticated are defined, so with
-- RLS enabled every client write is denied by default. Writes happen only via
-- the service-role key (bot publisher + dashboard control server action).
