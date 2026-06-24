# Proof Market Maker — Technical Reference

Deep engineering detail for the bot. For a plain-language overview of what it does, start with the main [README](../README.md). Always-on deployment is covered in [`deploy/README.md`](../deploy/README.md).

Market-making bot for [Proof.trade](https://proof.trade) (paper-trading competition).
See architecture: **ELO-3 §4–5**. This repo contains the **P0 spike (ELO-8)** —
the proof that the SDK wire works end-to-end — the **P1 paper-trading MVP
(ELO-9)**: a bot that quotes both sides on devnet paper, manages inventory at a
basic level, and cleanly resyncs after a socket drop — and the **P2 hardening
(ELO-10)**: a two-tier kill-switch, frozen-feed watchdog, rate-limit throttle,
crash-recovery journal with orphan reconcile-on-restart, and always-on
supervisor configs (pm2 / systemd / Docker).

## Layout

```
src/
  config.ts            env loading + Zod validation (secrets from env only)
  logger.ts            pino structured logs (BigInt-safe, secret-redacting)
  sdkAdapter.ts        THE one file that imports the Proof SDK (blast-radius isolation)
  orderbookStream.ts   live /ws client (the SDK's stream layer is broken vs devnet — see below)
  schemas.ts           Zod schemas for inbound WS frames; coerces wire ints -> BigInt
  book.ts              LocalBook: rebuild L2 book from snapshot + deltas
  nonceManager.ts      persistent, monotonic nonce high-water mark + SDK-safety gate
  diff.ts              pure desired-vs-resting diff -> Place / Cancel / CancelReplace
  strategy.ts          Strategy interface (§2) + FixedSpreadStrategy (inventory skew/cap)
  orderTracker.ts      order lifecycle (submitted->resting->filled/cancelled) + fill inference
  executor.ts          applies diff actions via the adapter; nonce gate; rate-limit; kill-switch
  bot.ts               MarketMaker runtime: stream -> quote -> diff -> execute, resync + hardening
  killControl.ts       two-tier kill-switch (run/soft/hard) via a local control file (ELO-10)
  staleWatchdog.ts     frozen-feed detector: silent socket -> stale -> pull quotes (ELO-10)
  tokenBucket.ts       rate-limit throttle for order submission (ELO-10)
  journal.ts           append-only crash-recovery journal + orphan-order reconcile (ELO-10)
  killswitch.ts        CLI: atomic cancel-all + drive the two-tier control file
  demoResync.ts        scripted proof: quote -> force drop -> resync -> re-quote -> flatten
  probe.ts             read-only connectivity + live-book check (places nothing)
  spike.ts             full E2E: connect -> stream -> place -> rest -> cancel -> latency
  cleanup.ts           safety: cancel all resting orders for our wallet
  *.test.ts            vitest units: nonceManager, diff, tokenBucket, killControl, staleWatchdog, journal
deploy/                always-on supervisor configs: pm2, systemd, Docker + ops runbook (ELO-10)
vendor/trading-sdk     git submodule, pinned @ 634f84b7 (the Proof SDK)
data/nonce.state       persisted nonce high-water mark (gitignored, created at runtime)
data/control           two-tier kill-switch mode (gitignored, run/soft/hard)
data/journal.jsonl     crash-recovery journal of order intents (gitignored)
```

## Setup & run

```bash
npm install                 # root deps (zod, pino, tsx, vitest, typescript)
git submodule update --init # fetch the pinned SDK
npm run setup               # install + build the vendored SDK to dist/
cp .env.example .env        # then fill PROOF_PRIVATE_KEY / PROOF_ADDRESS (gitignored)

npm run probe               # read-only: health, markets, live top-of-book
npm run spike               # places ONE post-only order far from mid and cancels it
npm run bot -- 1            # run the market maker on market 1 (BTC); Ctrl-C flattens
npm run demo:resync -- 1    # scripted: quote -> force socket drop -> resync -> re-quote -> flatten
npm run killswitch          # panic button: atomic cancel-all (optionally `-- <market>`)
npm run killswitch -- soft  # pause quoting, keep resting orders (two-tier, ELO-10)
npm run killswitch -- hard  # flatten + idle until cleared
npm run killswitch -- run   # resume normal quoting
npm run cleanup             # cancel any stray resting orders (iterative)
npm test                    # vitest units (nonce, diff, + ELO-10 reliability primitives)
npm run typecheck
```

Set `PINO_PRETTY=1` for human-readable logs; default is structured JSON.
Tunables (env): `MM_SPREAD_BPS`, `MM_QUOTE_SIZE`, `MM_MAX_INVENTORY`,
`MM_SKEW_BPS`, `MM_REQUOTE_MS`. Reliability knobs (ELO-10): `MM_STALE_MS`,
`MM_RATE_BURST`, `MM_RATE_PER_SEC`, `MM_CONTROL_FILE`, `MM_JOURNAL`.

**Always-on deploy:** see [`deploy/README.md`](deploy/README.md) for pm2 / systemd /
Docker supervisor setup, NTP requirement, durable `data/` state, and the
two-tier kill-switch operations guide.

## P1 design notes (ELO-9)

- **Nonce manager.** The SDK owns nonce allocation internally (timestamp
  `max(now, last+1)`, in-memory, resets to 0 on restart) with no injection hook.
  The only cross-restart hazard is a future-dated burst followed by a fast
  restart. `NonceManager` persists a high-water mark and **gates each submit
  until wall-clock passes it**, so the SDK's own allocator can never regress
  below a burned nonce — without reinventing the SDK's signing/commit path.
- **Resting truth.** Quoting reconciles against `queryOpenOrders` (the
  exchange's authoritative resting set) each tick, not against the local book —
  the book drives *pricing*, open-orders drive *what to cancel/replace*.
- **Resync.** On a socket drop the book is marked stale, quotes are pulled
  (kill-switch), and quoting halts until a fresh snapshot re-syncs the book.
  `npm run demo:resync` proves the full cycle live and flattens afterwards.

Secrets are loaded from `.env` via `node --env-file` only and never logged.

## P2 hardening notes (ELO-10)

Production-grade reliability layered onto the P1 runtime. Each primitive is a
small, pure/IO-isolated module with its own unit tests:

- **Two-tier kill-switch** (`killControl.ts`). The bot polls a local control file
  every tick. `soft` = stop placing new quotes but leave resting orders alone
  (a quiet pause); `hard` = atomic cancel-all then idle in-process (so the
  supervisor doesn't thrash-restart) until an operator sets `run`. Reachable via
  `npm run killswitch -- soft|hard|run` or a bare `echo hard > data/control`.
- **Frozen-feed watchdog** (`staleWatchdog.ts`). The P1 resync only fires on an
  *explicit* socket close. A socket can stay open while updates silently stop —
  just as dangerous. Every book frame feeds the watchdog; if the feed goes quiet
  past `MM_STALE_MS`, the book is marked stale and quotes are pulled, exactly
  like a real drop.
- **Rate-limit throttle** (`tokenBucket.ts`). Order submission passes through a
  token bucket (`MM_RATE_BURST` / `MM_RATE_PER_SEC`) so a requote storm can't
  trip the gateway's `429` throttling and cascade into reconnect loops.
- **Crash-recovery journal + orphan reconcile** (`journal.ts`). Order intents are
  appended to a durable JSONL journal. On restart, `reconcileOnStartup()` cancels
  any order the exchange still holds that the fresh (empty-tracker) process does
  not recognise — so **kill process → restart → no orphan orders**. This is the
  ELO-10 chaos-test criterion, coordinated with QA.

## SDK pinning & blast radius

The Proof SDK is vendored as a **git submodule pinned to commit
`634f84b7b9cb73de1c8957df75d9971dd16f6876`** (true commit-SHA pinning) and built
to `dist/`. **`src/sdkAdapter.ts` is the only file that imports it** — a future
SDK swap/upgrade is a one-file change.

## P0 spike findings (ELO-8)

Confirmed live against `api.dev.proof.trade` (`exchange-devnet-1`). These resolve
the gated unknowns flagged in ELO-4 (live fees / tick / lot / rate limits):

| Item | Finding |
|---|---|
| Connectivity | Devnet healthy; REST reads + order submit work via the SDK. |
| **Streaming** | **The SDK's `subscribeOrderbookDeltas` is broken vs this devnet** — it targets `/orderbook-deltas` (404) with a non-matching protocol. The real feed is a single socket at `wss://api.dev.proof.trade/ws`; subscribe with `{"method":"subscribe","params":{"channel":"orderbook","market":N}}`; frames are `snapshot` then `update` (single-level deltas; `totalQuantity:0` removes a level). We talk to it directly in `orderbookStream.ts`. |
| **Price unit** | **micro-USDC (6dp), not "cents" as the SDK README examples imply.** BTC best bid `62370676584` = `$62,370.68`. Pricing math must use the µUSDC scale. |
| **Fees (BTC)** | maker **2 bps**, taker **5 bps**. |
| **Margin (BTC)** | IM **3334 bps** (~3× max leverage), MM **1667 bps**. |
| **tick / lot** | `tickSize = 0`, `lotSize = 0` on devnet → no price/size granularity gate enforced. |
| **szDecimals (BTC)** | **5** → quantity is in 10⁻⁵ contracts (`qty=160` = 0.0016 BTC ≈ $100 notional). |
| Nonce lifecycle | Timestamp nonces (`max(now_ms, last+1)`), allocated by the SDK, burned on commit. No pre-sync needed. Observed `recent-nonces` count increment per tx. |
| **Commit latency** | **≈ 750–770 ms** per action (`submitTxCommit` = CheckTx-sync + poll `/tx` for DeliverTx). |
| Order events | `submitTxCommit` returns ABCI events; `order_placed` (snake_case) carries `order_id`. Open orders also expose the id via `queryOpenOrders`. |
| Rate limits | 20 rapid REST reads: 0 failures, ~12 ms/req, no `429`. Gateway surfaces throttling as `code:429`. Submit-side limits not yet hit at spike volume — to characterise under MM load in P2. |

### Markets
1323 markets on devnet; market `1` = BTC, `3` = SOL, `4` = WTI, `6` = NVDA, `7` = HYPE, etc.
