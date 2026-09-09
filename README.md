# Proof Market Maker

An automated trading bot that **makes markets** on [Proof.trade](https://proof.trade) — currently running on a **paper-trading** competition (play money, no real funds at risk).

## What does it actually do?

A **market maker** is a trader who is always willing to both buy *and* sell. Instead of betting on which way the price goes, it posts a price to buy slightly below the current price and a price to sell slightly above it, then earns the small gap in between (the "spread") each time someone trades against it.

This bot does that automatically, around the clock:

- 📈 **Quotes both sides** of a market (e.g. BTC) continuously, adjusting its prices as the market moves.
- ⚖️ **Manages its inventory** — if it ends up holding too much of one side, it leans its prices to sell that position back down, so it stays balanced rather than taking a big directional bet.
- 🔌 **Heals itself** when its connection to the exchange drops — it pauses, re-syncs, and picks back up without leaving stray orders behind.
- 🛑 **Has a panic button.** A two-stage kill switch lets an operator instantly pause quoting, or flatten everything and stand down, in one command.

It's built to run unattended and survive the messy realities of a live exchange — dropped connections, frozen data feeds, rate limits, and crashes.

## Is any real money involved?

**No.** It trades on Proof.trade's **development network** with paper (fake) money, as part of a trading competition. Think of it as a flight simulator for a trading strategy. No real funds, wallets, or customer money touch this code.

## Is it safe to make public? (no secrets here)

Yes. This repository contains **only code** — no passwords, no API keys, no wallet keys. The bot reads all its secrets from a private `.env` file on the machine it runs on, which is never included here. The `.env.example` files show the *names* of the settings with blank values, so you can see what's required without ever seeing a real secret.

## Want to try it yourself?

You'll need [Node.js](https://nodejs.org) installed. Then:

```bash
npm install                  # install dependencies
git submodule update --init  # fetch the exchange's SDK
npm run setup                # build the SDK

cp .env.example .env         # then fill in your paper-trading wallet details
```

Once set up, the most useful commands are:

| Command | What it does |
|---|---|
| `npm run probe` | Read-only health check — looks at the live market, places nothing. |
| `npm run bot -- 1` | Runs the market maker on market #1 (BTC). Press Ctrl-C to stop and clean up. |
| `npm run killswitch` | The panic button — instantly cancels all open orders. |
| `npm run demo:resync` | A scripted demo: quote → force a connection drop → recover → keep going. |

> **Always-on deployment** (running it 24/7 on a server) is covered in [`deploy/README.md`](deploy/README.md).

> **Ops dashboard** (live PnL, inventory, feed health and the kill switch in a browser) is the `dashboard/` folder here, also published on its own as [ClawdGItMan/proof-ops-dashboard](https://github.com/ClawdGItMan/proof-ops-dashboard).

## For developers

The deeper engineering detail — architecture, the exchange's wire protocol findings, the nonce/ordering safety model, the reliability primitives (kill switch, watchdog, rate limiter, crash-recovery journal), and how the SDK is pinned — lives in [`docs/TECHNICAL.md`](docs/TECHNICAL.md).

A quick map of the code:

- `src/bot.ts` — the main loop: read the market → decide quotes → place/cancel orders → recover from drops.
- `src/strategy.ts` — the pricing strategy (spread, inventory skew, position caps).
- `src/sdkAdapter.ts` — the single file that talks to the Proof exchange SDK.
- `src/killControl.ts`, `staleWatchdog.ts`, `tokenBucket.ts`, `journal.ts` — the safety/reliability layer.
- `deploy/` — supervisor configs (pm2 / systemd / Docker) for always-on running.

Run `npm test` for the unit tests and `npm run typecheck` for type checking.
