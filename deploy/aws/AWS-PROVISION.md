# AWS EC2 provisioning runbook — bot + dashboard on one box (ELO-24)

Board decision **ELO-20** consolidates all infra on **AWS** and drops the separate
**Vercel** dashboard (ELO-21). One **t3.small** EC2 box now runs both:

- `proof-mm.service` — the always-on market-maker bot (ELO-14)
- `proof-dashboard.service` — the Next.js ops dashboard, loopback-bound (ELO-17)

They are **co-located, not coupled**: each is an independent Supabase client. The
bot publishes `bot_state` and applies kill-switch commands from Supabase; the
dashboard reads state and writes commands to Supabase via the `dashboard-rpc` Edge
Function. Supabase, the kill-switch, and operator auth are **unchanged** by this move.

```
                         AWS EC2 t3.small (Ubuntu 24.04)
   operator ──SSH 22──▶ ┌─────────────────────────────────────────┐
   (IP-locked)          │  systemd: proof-mm.service  (the bot)    │
                        │  systemd: proof-dashboard.service        │
   operator ──tunnel──▶ │    └ next start, bound 127.0.0.1:3100    │
   :3100 (default)      └───────────────┬─────────────────────────┘
                                        │ both are Supabase clients
                                        ▼
                          Supabase (Postgres + dashboard-rpc Edge Function)
                          service-role key stays inside the Edge Function
```

## Blocker (human-only) — ELO-20

This script needs **AWS credentials with EC2 permissions**. The founder must run
`aws configure` (or export `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) for an
IAM principal that can manage EC2 key pairs, security groups, and instances — or
authorize an agent-owned AWS account on the approved budget. The CEO is collecting
this on ELO-20; everything below is ready to run the moment creds land.

## One command (from the repo root)

```bash
# 1. Secrets must exist locally first (never committed):
#    ./.env                  -> PROOF_PRIVATE_KEY / PROOF_ADDRESS
#    ./dashboard/.env.local  -> operator Basic-Auth creds + Supabase keys (see dashboard/.env.example)

# 2. Provision (SSH ingress is locked to your current public IP):
OPERATOR_IP=$(curl -s ifconfig.me) deploy/aws/provision-ec2.sh
```

That single command, idempotently:

1. creates/reuses an EC2 key pair (`~/.ssh/proof-mm.pem`),
2. creates/reuses a security group — **SSH (22) open to your IP only**,
3. resolves the latest Ubuntu 24.04 AMI,
4. launches (or reuses) a tagged `t3.small` with a 20 GB gp3 volume,
5. `rsync`s the repo to `/opt/proof-market-maker` (excludes `.git`, `node_modules`, `.vercel`, secrets),
6. `scp`s `.env` and `dashboard/.env.local` out-of-band,
7. runs `deploy/bootstrap.sh` on the box — installs Node 22, enforces NTP sync,
   builds the bot + dashboard, and enables both systemd units.

Override defaults via env: `AWS_REGION`, `INSTANCE_TYPE`, `KEY_NAME`, `NAME`, `VOLUME_GB`.

## Reaching the dashboard

**Default — SSH tunnel (no public port, no TLS, no domain needed).** The dashboard
binds to `127.0.0.1:3100` and is never exposed publicly, so the operator Basic-Auth
password never crosses the network in clear text:

```bash
ssh -i ~/.ssh/proof-mm.pem -L 3100:127.0.0.1:3100 ubuntu@<PUBLIC_IP>
# then open http://localhost:3100  (operator Basic-Auth still applies)
```

**Opt-in — public HTTPS via Caddy.** If you want a public URL (the Vercel
replacement), provide a domain and an ACME email. Bootstrap installs Caddy, which
terminates auto-renewing Let's Encrypt TLS in front of the loopback dashboard, and
the security group opens 80 + 443:

```bash
OPERATOR_IP=$(curl -s ifconfig.me) \
DASHBOARD_DOMAIN=ops.example.com ACME_EMAIL=you@example.com \
  deploy/aws/provision-ec2.sh
# then point an A record for ops.example.com at <PUBLIC_IP>
```

Either way the ELO-17 fail-closed operator Basic-Auth is enforced inside Next.js —
Caddy only adds the TLS layer the raw box lacks.

## After provisioning

- Bot logs: `ssh -i ~/.ssh/proof-mm.pem ubuntu@<PUBLIC_IP> 'journalctl -u proof-mm -f'`
- Both services: `journalctl -u proof-mm -u proof-dashboard -f`
- **Run the crash-recovery acceptance test** in `deploy/PROVISION.md` §5
  (kill → auto-restart → reconcile → no orphan orders; reboot survival).

## Teardown

```bash
aws ec2 terminate-instances --instance-ids <IID>
aws ec2 delete-security-group --group-name proof-mm-sg   # after the instance is gone
```

## What this retires

- The Hetzner host recommendation (ELO-14 §0) — superseded by EC2.
- The Vercel deploy path (ELO-21) — `dashboard/.vercel/` is no longer the deploy
  target; the dashboard ships as a systemd service on the EC2 box. The Vercel
  project can be deleted once this EC2 path is verified live (track on ELO-21).
