# ELO-13 — Read-only ops dashboard (design)

**Date:** 2026-06-24
**Author:** Staff Engineer (pre-build design / review)
**Parent:** ELO-10 (P2 hardening). Builds on `killControl.ts`, `staleWatchdog.ts`,
`journal.ts`, `bot.ts` (all on `main`).

---

## 1. Goal & "done when"

A **read-only** Next.js + Supabase dashboard that shows live bot state — PnL,
inventory/net position, open orders, connection/feed health, last-tick/heartbeat
— plus an **audit log**, and a **kill-switch button** (run / soft / hard) that
flips the bot's mode **within one tick**. Secrets (`PROOF_PRIVATE_KEY`) never
reach the client; the dashboard is read-only except for the control write.

---

## 2. The decisive architecture problem: where does control live?

The bot reads its kill-switch from a **local file** `data/control` on its
always-on VM (per `PROVISION.md`: systemd on a single Hetzner/DO host; operators
flip it with `echo hard > data/control`). The standard stack puts the dashboard
on **Vercel + Supabase** — *different infrastructure*. **A Vercel server action
cannot write a file on the bot's VM.** So the literal reading of the issue
("dashboard writes the control file") only works if dashboard and bot are
co-located. They are not. The control path must be mediated.

### Options

- **A — Co-located dashboard (literal).** Run Next.js on the *same VM* as the
  bot; the server action writes `data/control` directly via `KillControl`.
  *Pro:* simplest, matches issue text verbatim, no new control surface. *Con:*
  throws away the serverless/Vercel model, couples the dashboard's uptime and
  deploy to the trading host, exposes a web server on the trading VM (new attack
  surface next to the signing key), and the founder still has to host it.

- **B — Supabase-mediated control (RECOMMENDED).** The dashboard server action
  writes a desired mode to a Supabase `bot_control` row (RLS-locked, writable
  only by a server-side service role). The bot gains a tiny **control bridge**
  in its tick: it polls that row and *mirrors* it into the existing local
  `data/control` file via `KillControl.set()`. The trading loop keeps reading
  the **local file** as its single source of truth — so the manual
  `echo hard > data/control` failsafe and the `killswitch` CLI still work, and
  the file remains the last line of defense if Supabase is unreachable.
  *Pro:* fits the chosen stack, keeps bot and dashboard independently
  deployable, adds no inbound network surface to the trading VM (bot only makes
  *outbound* calls to Supabase), preserves the local-file failsafe. *Con:* one
  extra hop; control latency = bot tick interval + Supabase poll (still
  "within a tick" as required).

- **C — Direct HTTP control endpoint on the bot.** Bot exposes an authenticated
  HTTP endpoint the dashboard calls. *Rejected:* opens an inbound port on the
  trading VM right next to the signing key — the worst trust-boundary choice.

**Recommendation: B.** It is the only option that satisfies the stated stack,
keeps the trading VM free of inbound surface, and preserves the local-file
failsafe the whole ELO-10 design leans on.

### Why "local file stays authoritative" matters (a safety invariant)

The trading loop must **never** trust the network for "should I stop?". If
Supabase is down or lying, the bot must still honor the local file and the CLI.
So the bridge is *write-only into the file from the cloud*; the loop's read is
unchanged. A cloud outage can fail to *start* a stop, but can never *prevent*
one — and a stop set locally is never overridden by a stale cloud value.

---

## 3. Components

### 3.1 Bot side (this repo — topology-independent, no spend)

- **`src/publisher.ts` — `BotStatePublisher`.** Optional dependency on
  `MarketMaker` (same pattern as `killControl?`, `watchdog?`, `journal?`). Each
  tick (or every Nth tick) it publishes a single snapshot row: net position,
  open-order count + summary, mid, PnL estimate, stale flag, watchdog
  `sinceLast`, resync count, and a monotonic `heartbeat_at`. Dependency-injected
  Supabase client; **no-ops when unconfigured** (so tests and paper-trading run
  without Supabase). All writes are best-effort and wrapped — a publish failure
  must never break a tick or stop quoting.
- **Audit log publish.** The bot already appends order intents to
  `journal.jsonl`. The publisher mirrors *audit-relevant* journal entries
  (place/cancel/cancelAll/fill/boot + kill-switch transitions) into a Supabase
  `audit_log` table so the dashboard never reads the bot's local disk.
- **`src/controlBridge.ts` — control mirror.** Pure decision function
  `resolveControl(local, remote)` (unit-tested with no I/O) + a thin poller that
  reads the Supabase `bot_control` row and, when it differs and is newer, calls
  `KillControl.set()`. Wired into `tick()` *before* the existing local read, so
  a dashboard flip lands within the same tick the loop next runs.

### 3.2 Supabase (schema as migration SQL; project provisioning is a spend gate)

Tables (all with **RLS on**, per CLAUDE.md non-negotiables):
- `bot_state` — latest snapshot (single logical row per bot/market, upserted).
- `open_orders` — current resting orders snapshot (replace-on-publish).
- `audit_log` — append-only event stream for the audit view.
- `bot_control` — desired mode (`run|soft|hard`) + `updated_at` + `updated_by`.

RLS: anon/authenticated read = SELECT only on state/orders/audit; **no client
writes** to any table. `bot_control` writes happen **only** via the Next.js
server action using the **service role key** (server-side env, never shipped to
the browser). The bot writes via the service role too (outbound only).

### 3.3 Dashboard (Next.js App Router, read-only)

- Server Components read `bot_state` / `open_orders` / `audit_log` via the
  Supabase server client; live updates via Supabase Realtime subscription (or a
  short poll fallback). Panels: PnL, inventory/net, open orders, health
  (uses the published watchdog signal + heartbeat staleness), audit log.
- **Kill-switch button** → server action (`"use server"`) → writes `bot_control`
  with the service role key. Confirm dialog on `hard`. Optimistic UI shows
  "pending → applied" once the bot's published `bot_state.control_applied`
  echoes the new mode (closes the loop visually).

---

## 4. PnL — must be defined, not assumed

There is **no PnL accumulator in the codebase today.** Net position and inferred
fills exist; realized/unrealized PnL does not. Options for v1:

- **v1 (recommended): mark-to-market inventory value + realized cash from fills.**
  Track cumulative signed cash from inferred fills (price×qty) as *realized*, and
  `net_position × mid` as *unrealized mark*. Approximate (uses inferred fills,
  not exchange-confirmed fills, and mid as the mark) but honest and labeled as an
  estimate. Lives in a small `src/pnl.ts` accumulator, unit-tested.
- **v0 (descope): show net position + inventory notional only**, defer true PnL.

Either is fine for a read-only ops view; this needs a founder call so the
dashboard doesn't display a number we can't stand behind.

---

## 5. Testing

- `controlBridge` resolve logic — pure unit tests (local-wins-on-tie,
  newer-remote-applies, malformed-remote-ignored).
- `publisher` — DI'd fake client: asserts no-op when unconfigured, best-effort
  on client throw (tick never rejects), correct snapshot shape.
- `pnl` accumulator — fills in/out, flat round-trip = realized only, etc.
- Dashboard: a server-action test that the button writes the expected row;
  RLS smoke test that an anon client **cannot** write any table.
- The real failure mode to test, not just the happy path: **publish failure must
  not stop quoting**, and **a cloud value must never override a local `hard`.**

---

## 6. Decision gates (need founder input before build)

1. **Control topology:** confirm Option **B** (Supabase-mediated, local file
   stays authoritative).
2. **Spend / provisioning:** creating a Supabase project (+ Vercel deploy) is
   real standing infra — per this repo's own `PROVISION.md §0`, infra spend is a
   founder-approval gate. Greenlight provisioning, or point me at existing
   Supabase/Vercel projects to reuse.
3. **PnL scope:** v1 mark-to-market estimate, or v0 net-position-only for now?

On approval I build the bot-side core first (publisher + control bridge + PnL +
schema migration + tests — all topology-independent), then the dashboard.

---

## 7. Build outcome (2026-06-24) — write path revised

Implemented and verified against the live project `yafulngyxgzypcouutqt`. One
design change from §3 emerged during provisioning: **the Supabase MCP does not
expose the service-role key, and `PROVISION.md` forbids putting secrets in the
issue thread.** So rather than the service-role-over-PostgREST write path in §3.1,
writes go through a Supabase **Edge Function** (`dashboard-rpc`):

- The function holds the service-role key *inside Supabase* (auto-injected) and
  authenticates callers by `sha256(shared-secret)`. The master key never lands on
  the trading VM next to the signing key — a leaked bot secret only grants
  "publish dashboard rows".
- Bot **writes** → `POST /functions/v1/dashboard-rpc` (ops: `publish`, `audit`,
  `control`) with `BOT_PUBLISH_SECRET`. Bot **reads** (`readControl`) → anon key +
  PostgREST (RLS allows SELECT).
- `EdgeFunctionGateway` replaces `RestDashboardGateway`; interface simplified to
  `publishSnapshot` / `appendAudit` / `readControl`.
- The dashboard's control-write (ELO-17) uses the same `control` op; it should get
  its own secret hash (separate blast radius) provisioned out-of-band.

Verified: anon read ✓ / anon write denied (401, 42501) ✓; real gateway publish +
audit ✓; dashboard `control` write → bot `readControl` round-trip ✓.

---

## 8. ELO-17 build outcome (2026-06-24) — Next.js dashboard + control secret scoping

The UI half is built under `dashboard/` (Next.js 14 App Router, Tailwind, no
`@supabase/supabase-js` — plain fetch). Read panels (PnL, inventory, feed health,
open orders, audit) render per market; a client component short-polls `/api/state`
every 2s (Realtime deferred — 2s poll is ample for an ops view and adds no
replication config or browser-client failure surface).

**Security correction to the issue text.** ELO-17's issue said the kill-switch
server action should write `bot_control` "using the service-role key server-side
only." That predates §7. Shipping the service-role key to Vercel would re-introduce
the exact blast radius the Edge Function was built to avoid. So the realized path:
the `"use server"` action presents a **control-scoped** shared secret to the
`dashboard-rpc` `control` op. To give it a *separate blast radius* (as §7 asked),
the function now maps each secret hash → the ops it may invoke:

- bot publish secret → `publish` + `audit` + `control` (unchanged);
- **dashboard control secret → `control` only.** A leaked dashboard secret cannot
  forge `bot_state`/`audit` rows.

The `control` op also now validates `mode`/`updated_at_ms` and writes only the four
known columns (defense-in-depth at the trust boundary). Edge function redeployed to
`yafulngyxgzypcouutqt` as **version 2** (additive — the bot's existing secret keeps
all ops; no publish-path regression).

**Verified live (project `yafulngyxgzypcouutqt`):**
- dashboard secret + `control` → 200, row read back ✓; dashboard secret + `publish`
  → **403** ✓ (blast radius enforced); bot secret + `control` → 200 ✓ (no
  regression); bad `mode` → 400 ✓; garbage secret → 401 ✓.
- `npm run build` + `tsc --noEmit` clean; `npm test` (bigint formatting incl.
  exactness past 2^53) green.
- Browser end-to-end (Playwright): panels render seeded live data; clicking **SOFT**
  wrote `bot_control{mode:soft, updated_by:dashboard}` and the UI showed
  "desired SOFT — waiting for bot to echo…"; **HARD** raised the confirm dialog.
- All seed/test rows deleted afterward; the live tables are back to empty.

**Operator auth (added after a security pass).** A privileged kill-switch behind an
*unauthenticated* Server Action is a DoS on the strategy — and a public read view
leaks live positions. So the whole dashboard is gated by fail-closed HTTP Basic Auth
(`DASHBOARD_BASIC_AUTH_USER`/`PASSWORD`): edge middleware blocks unauthenticated
requests, and `setControlMode` re-verifies independently (a Server Action is a public
POST endpoint — never trust the page in front of it). No credential configured → 503,
so it can never deploy open. The operator id is attributed in `bot_control.updated_by`.
Single shared credential is proportionate for a solo operator; SSO + allowlist is the
upgrade path. Verified: no/bad creds → 401, good creds → 200, fail-closed unit-tested.

**Still founder-gated (not blocking the build):** a Vercel project to deploy to, and
a *running bot* pointed at this Supabase project to observe the within-a-tick mode
flip live (the bridge logic itself is unit-tested in `src/controlBridge.test.ts`).
The dashboard control secret's raw value must be set as a server-only Vercel env var
out-of-band (its hash is embedded in the function; the raw value is in
`dashboard/.env.local`, gitignored).
