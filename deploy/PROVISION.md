# From-zero provisioning runbook + acceptance test (ELO-14, ELO-24)

Turnkey sequence to take a fresh Linux VM to the bot running unattended under a
supervisor that auto-restarts on crash. Pairs with `deploy/README.md` (supervisor
reference). Supervisor of record: **systemd** — one always-on process on a Linux
host, survives reboot, journal logging, no extra runtime daemon (pm2/Docker).

> **ELO-24 update — host of record is now AWS EC2.** Board decision ELO-20
> consolidates infra on AWS (dropping Hetzner + the separate Vercel dashboard).
> The bot **and** the ops dashboard now run co-located on one EC2 box. The
> one-command path is **`deploy/aws/provision-ec2.sh`** (see `deploy/aws/AWS-PROVISION.md`);
> §1–§4 below remain valid as the manual/portable fallback for any Ubuntu host.
> §5 (the crash-recovery acceptance test) is host-agnostic and unchanged.

## 0. Host of record (AWS — board decision ELO-20)

| Option            | Spec            | ~Cost/mo | Notes                                          |
| ----------------- | --------------- | -------- | ---------------------------------------------- |
| **AWS EC2 t3.small** | 2 vCPU / 2 GB | ~$15     | **Chosen** — consolidates all infra on AWS     |
| _Hetzner CX22_    | 2 vCPU / 4 GB   | ~$5      | _Retired (ELO-24): cheaper but off-AWS_         |
| _AWS Lightsail_   | 2 GB            | ~$12     | _Alt AWS option; EC2 picked for IAM/SG control_ |

- **OS:** Ubuntu 24.04 LTS (AMI auto-resolved by the provisioning script).
- **Region:** for paper-trading, any reliable region is fine. Latency to the
  Proof matching engine matters for a *live* maker — revisit region choice when
  we go live (open question: where is `api.dev.proof.trade` hosted?).
- **Spend:** ~$15/mo (t3.small + 20 GB gp3). Real money on a real account →
  founder must provide AWS creds / authorize the agent-owned account (ELO-20).

## 1. Base host (as root on fresh Ubuntu 24.04)

```bash
apt-get update && apt-get install -y git curl
# Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
# MANDATORY: NTP sync — the engine validates a wall-clock timestamp nonce;
# clock drift burns future nonces and wedges the bot (engine code 21).
timedatectl set-ntp true
timedatectl status | grep -i 'synchronized'   # must read: System clock synchronized: yes
# Dedicated non-login service user
useradd -r -m -d /opt/proof-market-maker -s /usr/sbin/nologin proofmm
```

## 2. Deploy the code (as the service user)

```bash
sudo -u proofmm -H bash -c '
  cd /opt/proof-market-maker
  git clone --recurse-submodules <REPO_URL> .
  npm ci && npm run setup        # setup = sdk:install + sdk:build (vendored SDK)
'
```

## 3. Inject secrets — never commit, never echo

`.env` holds `PROOF_PRIVATE_KEY` / `PROOF_ADDRESS`. Transfer it out-of-band
(scp from operator laptop, or paste into an editor over SSH). **Do not** `echo`
the key, put it in shell history, bake it into the unit file, or log it.

```bash
# from operator laptop, NOT checked into git anywhere:
scp .env proofmm@<HOST>:/opt/proof-market-maker/.env
ssh proofmm@<HOST> 'chmod 600 /opt/proof-market-maker/.env'
```

Confirm it loads without printing the value:

```bash
sudo -u proofmm node -e 'require("dotenv");' 2>/dev/null; \
  grep -q PROOF_PRIVATE_KEY /opt/proof-market-maker/.env && echo ".env present" || echo "MISSING"
```

## 4. Install the supervisor (systemd)

```bash
sudo cp /opt/proof-market-maker/deploy/proof-mm.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now proof-mm
journalctl -u proof-mm -f        # watch it subscribe, reconcile, then quote
```

(Edit `User=`/`WorkingDirectory=` in the unit if you changed paths above.)

## 5. Acceptance test — the ELO-14 "Done when"

Prove **crash → auto-restart → clean reconcile → no orphan orders**, unattended.

```bash
# A. Confirm it is up and quoting.
systemctl is-active proof-mm                      # -> active
journalctl -u proof-mm -n 20 --no-pager           # -> "quoting", no errors

# B. Note the PID, then hard-kill it (SIGKILL = uncatchable, simulates a crash).
PID=$(systemctl show -p MainPID --value proof-mm)
sudo kill -9 "$PID"

# C. systemd must relaunch within RestartSec (2s). Confirm a NEW pid.
sleep 5 && systemctl is-active proof-mm           # -> active
test "$(systemctl show -p MainPID --value proof-mm)" != "$PID" && echo "restarted: new PID"

# D. The restart log MUST show reconcileOnStartup running BEFORE any new quote.
journalctl -u proof-mm --since '15 seconds ago' --no-pager | grep -i 'reconcil'

# E. Reboot survival.
sudo reboot
# after it comes back:
systemctl is-active proof-mm                       # -> active (enabled at boot)
```

**Pass criteria:** B→C yields a new PID without operator action; D shows reconcile
ran before quoting (no orphan orders); E shows it returns after a full reboot.

## 6. Rollback / stop

```bash
sudo systemctl stop proof-mm        # SIGINT → bot flattens quotes before exit
echo hard > /opt/proof-market-maker/data/control   # or: flatten in place, leave supervised
```
