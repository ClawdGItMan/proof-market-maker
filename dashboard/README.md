# Proof MM — Ops Dashboard (ELO-17)

Read-only Next.js dashboard for the Proof market maker. The UI half of ELO-13.

## What it shows

Per market (the bot may run several), live every 2s:

- **PnL** — maker estimate from inferred fills, marked at mid (labeled as an estimate, not exchange-confirmed).
- **Inventory** — net position (lots), mid, best bid/ask.
- **Feed / connection health** — published `stale` flag, watchdog `stale_since_ms`, resync count, open-order count, and a heartbeat-age check (a heartbeat older than 15s reads as a stale feed even if the bot never published `stale`).
- **Open orders** — current resting orders.
- **Audit log** — latest events (place/cancel/fill/boot/control).
- **Kill switch** — RUN / SOFT / HARD, with a confirm dialog on HARD.

## Trust model (non-negotiable)

- **Operator auth, fail-closed.** The whole app (read panels + the kill-switch
  action) sits behind HTTP Basic Auth (`DASHBOARD_BASIC_AUTH_USER` /
  `DASHBOARD_BASIC_AUTH_PASSWORD`). Edge middleware gates every request, and the
  kill-switch action **re-verifies independently** — a Server Action is a public
  POST endpoint, so it never trusts the page in front of it. If no credential is
  configured the dashboard refuses to serve (503), so a kill-switch is never exposed
  open. Single shared operator credential is proportionate here; SSO (Supabase
  Auth / Clerk / NextAuth) + an operator allowlist is the upgrade path. The
  authenticated operator id is attributed in `bot_control.updated_by`.
  - **Operator note — log in via the browser's native auth prompt, not the URL.**
    Do **not** open `https://user:pass@host`. Chromium rejects credentials embedded
    in the URL for client-side `fetch`, which silently breaks the live poll **and the
    kill-switch buttons** (you'll only see a faint `○ dashboard read failing`). Use a
    clean URL and enter the operator credential when the browser prompts. (Verified in
    ELO-23 live QA.)
- The **anon/publishable key** is the only Supabase credential in the browser. RLS
  (`supabase/migrations/0001_dashboard.sql`) grants it SELECT on the observable
  tables and **denies every client write**.
- The **kill-switch write never uses the service-role key.** The `"use server"`
  action (`src/app/actions.ts`) presents a **control-scoped shared secret**
  (`DASHBOARD_CONTROL_SECRET`, server-side env only) to the `dashboard-rpc` Edge
  Function's `control` op. That function holds the service-role key *inside
  Supabase*. A leaked dashboard secret can **only** flip the kill-switch mode — the
  function's op-scoping denies it `publish`/`audit`, so it cannot forge bot state.
- `PROOF_PRIVATE_KEY` never touches Supabase or this app.

## How the kill-switch reaches the bot

Button → server action → `bot_control` row (monotonic `updated_at_ms`). The bot's
`controlBridge` (in the bot repo) polls that row each tick and mirrors a *fresher*
command into its local `data/control` file, which stays the single source of truth.
A cloud outage can never *prevent* a stop, and a stale cloud value never overrides a
local `hard`. So the dashboard request lands within one bot tick.

## Run locally

```bash
cp .env.example .env.local   # fill NEXT_PUBLIC_SUPABASE_ANON_KEY + DASHBOARD_CONTROL_SECRET
npm install
npm run dev                  # http://localhost:3100
npm test                     # format/bigint unit tests
npm run build                # production build
```

### Env

| var | scope | purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | public | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | RLS-limited read key (safe in browser) |
| `DASHBOARD_CONTROL_SECRET` | **server only** | control-scoped secret for the kill-switch write |
| `DASHBOARD_MARKETS` | server, optional | comma-separated market ids to show (default: all published) |

## Deploy

**Co-located on the bot's AWS EC2 box (ELO-24).** Board decision ELO-20 consolidates
infra on AWS and retires the standalone Vercel deploy (ELO-21). The dashboard now
ships as a `proof-dashboard.service` systemd unit alongside the bot — `next build`
then `next start` bound to `127.0.0.1:3100`, reached over an SSH tunnel by default
(or public HTTPS via Caddy when a domain is supplied). One-command provisioning and
the full topology are in **`deploy/aws/AWS-PROVISION.md`**; secrets (the table above)
live in `dashboard/.env.local` injected out-of-band, never committed.

_Historical: an earlier build ran this on Vercel (`proof-ops-dashboard.vercel.app`).
That path is retired; delete the Vercel project once the EC2 deploy is verified live
(tracked on ELO-21)._

## Numeric note

Prices/sizes/order-ids are u64 / µUSDC and exceed `Number` safety, so they cross
the wire as decimal strings and are parsed with `BigInt`, never `Number`
(`src/lib/format.ts`, unit-tested for exactness past 2^53).
