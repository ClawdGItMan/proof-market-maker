# Always-on deployment & operations (ELO-10)

Run the market maker as a supervised, auto-restarting process on a small
always-on VM. Three interchangeable supervisors are provided — pick one:

| Supervisor | File                      | Start                                                        |
| ---------- | ------------------------- | ----------------------------------------------------------- |
| pm2        | `ecosystem.config.cjs`    | `pm2 start deploy/ecosystem.config.cjs && pm2 save`         |
| systemd    | `proof-mm.service`        | `sudo systemctl enable --now proof-mm`                      |
| Docker     | `Dockerfile`              | `docker run --restart=unless-stopped --env-file .env …`     |

All three auto-restart the bot on crash. On every (re)start the bot runs
`reconcileOnStartup()`, which cancels any order the exchange still holds that the
fresh process does not recognise — so **kill the process → restart → no orphan
orders**, the ELO-10 done-criterion.

## Host prerequisites

- **Node ≥ 22**, then `npm install && git submodule update --init && npm run setup`.
- **NTP-synced clock — mandatory.** The Proof engine validates each tx against a
  wall-clock *timestamp nonce*; a host whose clock drifts ahead can burn future
  nonces and wedge the bot (engine code 21). Enable NTP:
  ```bash
  sudo timedatectl set-ntp true
  timedatectl status        # confirm "System clock synchronized: yes"
  ```
- **`.env`** (gitignored) holds `PROOF_PRIVATE_KEY` / `PROOF_ADDRESS`. Never bake
  secrets into the unit file, image, or pm2 manifest — they are loaded from
  `.env` at runtime via `tsx --env-file`.

## Two-tier kill-switch (control file)

The bot polls a local control file (`MM_CONTROL_FILE`, default `data/control`)
every tick. Flip it with the CLI (effective within one tick, no restart):

```bash
npm run killswitch -- soft   # pause: stop placing new quotes, keep resting orders
npm run killswitch -- hard   # flatten: atomic cancel-all, then idle until cleared
npm run killswitch -- run    # resume normal two-sided quoting
npm run killswitch -- 1      # immediate atomic cancel-all on market 1 (also latches hard)
```

Or by hand, if every other control plane is down:

```bash
echo hard > data/control     # bot cancels all and idles next tick
echo run  > data/control     # resume
```

`soft` vs `hard`: **soft** is a quiet pause (leave the book as-is, stop churning);
**hard** is "get me flat now" (cancel everything, sit idle under the supervisor
without thrash-restarting) until an operator sets `run`.

## Durable state (persist across restarts)

Everything under `data/` (gitignored) must survive restarts — mount it as a
volume for Docker:

- `data/nonce.state` — monotonic nonce high-water mark (prevents replay wedge).
- `data/control` — current kill-switch mode.
- `data/journal.jsonl` — append-only crash-recovery journal of order intents.

## Reliability knobs (env)

| Var                | Default | Meaning                                            |
| ------------------ | ------- | -------------------------------------------------- |
| `MM_STALE_MS`      | 15000   | Frozen-feed watchdog threshold (silent socket).    |
| `MM_RATE_BURST`    | 8       | Token-bucket burst capacity for submissions.       |
| `MM_RATE_PER_SEC`  | 4       | Token-bucket sustained submit rate.                |
| `MM_CONTROL_FILE`  | data/control | Two-tier kill-switch control file.            |
| `MM_JOURNAL`       | data/journal.jsonl | Crash-recovery journal path.            |
