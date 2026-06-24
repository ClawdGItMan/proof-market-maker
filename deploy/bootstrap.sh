#!/usr/bin/env bash
# One-shot, idempotent provisioner for the always-on market maker (ELO-14, ELO-24).
# Targets a fresh Ubuntu 24.04 host (AWS EC2 t3.small of record; any Ubuntu works).
# Run as root where the repo is already present (rsync/scp it to APP_DIR first —
# this repo has no git remote to clone from; deploy/aws/provision-ec2.sh does this).
#
#   sudo APP_DIR=/opt/proof-market-maker deploy/bootstrap.sh
#
# Provisions BOTH co-located services on this one box (ELO-24 consolidation):
#   - proof-mm.service        the always-on bot
#   - proof-dashboard.service the Next.js ops dashboard (loopback 127.0.0.1:3100)
# Optionally fronts the dashboard with Caddy auto-HTTPS when DASHBOARD_DOMAIN is set.
#
# Safe to re-run: every step checks state before acting. It never prints any
# secret; it only verifies that .env / dashboard/.env.local exist and are non-empty.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/proof-market-maker}"
SVC_USER="${SVC_USER:-proofmm}"
MARKET="${MARKET:-1}"
# BOT_ONLY=1 provisions ONLY the always-on bot and skips the co-located dashboard
# (its secret check, build, and systemd unit). Set per ELO-26: the ops dashboard
# stays on Vercel (already live) and must NOT be touched/migrated onto this box.
BOT_ONLY="${BOT_ONLY:-0}"
# Optional: public HTTPS for the dashboard via Caddy. Unset => dashboard stays
# loopback-only and is reached over an SSH tunnel (no public port, no TLS needed).
DASHBOARD_DOMAIN="${DASHBOARD_DOMAIN:-}"
# Email used by Caddy for the Let's Encrypt account (only when DASHBOARD_DOMAIN set).
ACME_EMAIL="${ACME_EMAIL:-}"

log() { printf '\n=== %s ===\n' "$1"; }

[ "$(id -u)" -eq 0 ] || { echo "must run as root (sudo)"; exit 1; }

log "1. base packages"
if ! command -v node >/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 22 ]; then
  apt-get update -qq
  apt-get install -y -qq git curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

log "2. NTP sync (MANDATORY — engine uses a wall-clock timestamp nonce)"
timedatectl set-ntp true
for _ in $(seq 1 10); do
  timedatectl show -p NTPSynchronized --value | grep -q yes && break
  sleep 2
done
timedatectl show -p NTPSynchronized --value | grep -q yes \
  || { echo "FATAL: clock not NTP-synced — bot would burn nonces and wedge"; exit 1; }
echo "clock synchronized: yes"

log "3. service user"
id "$SVC_USER" >/dev/null 2>&1 || useradd -r -d "$APP_DIR" -s /usr/sbin/nologin "$SVC_USER"

log "4. code present + secrets present"
[ -f "$APP_DIR/package.json" ] || { echo "FATAL: copy the repo to $APP_DIR first"; exit 1; }
if [ ! -s "$APP_DIR/.env" ]; then
  echo "FATAL: $APP_DIR/.env missing/empty."
  echo "Inject it out-of-band (scp from operator laptop); never commit or echo the key:"
  echo "  scp .env ${SVC_USER}@<host>:$APP_DIR/.env && chmod 600 $APP_DIR/.env"
  exit 1
fi
grep -q '^PROOF_PRIVATE_KEY=.\+' "$APP_DIR/.env" || { echo "FATAL: PROOF_PRIVATE_KEY not set in .env"; exit 1; }
chmod 600 "$APP_DIR/.env"
echo ".env present (value not shown)"

# Dashboard secrets (ELO-17 fail-closed). Operator Basic-Auth creds are REQUIRED —
# without them the dashboard serves 503, so a missing file here means a dead panel.
# Skipped entirely in BOT_ONLY mode (ELO-26: dashboard stays on Vercel).
if [ "$BOT_ONLY" != 1 ]; then
  DASH_ENV="$APP_DIR/dashboard/.env.local"
  if [ ! -s "$DASH_ENV" ]; then
    echo "FATAL: $DASH_ENV missing/empty."
    echo "Inject it out-of-band (scp), mirroring dashboard/.env.example; never commit it:"
    echo "  scp dashboard/.env.local ${SVC_USER}@<host>:$APP_DIR/dashboard/.env.local"
    exit 1
  fi
  for k in DASHBOARD_BASIC_AUTH_USER DASHBOARD_BASIC_AUTH_PASSWORD NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY; do
    grep -q "^$k=.\+" "$DASH_ENV" || { echo "FATAL: $k not set in dashboard/.env.local"; exit 1; }
  done
  chmod 600 "$DASH_ENV"
  echo "dashboard/.env.local present (values not shown)"
else
  echo "BOT_ONLY=1 — skipping dashboard secrets (dashboard stays on Vercel)"
fi
chown -R "$SVC_USER" "$APP_DIR"

log "5. install deps + build vendored SDK (bot)$([ "$BOT_ONLY" != 1 ] && echo ' + build dashboard')"
sudo -u "$SVC_USER" -H bash -c "cd '$APP_DIR' && npm ci --no-audit --no-fund && npm run setup"
if [ "$BOT_ONLY" != 1 ]; then
  # Dashboard is a separate npm workspace with its own lockfile.
  sudo -u "$SVC_USER" -H bash -c "cd '$APP_DIR/dashboard' && npm ci --no-audit --no-fund && npm run build"
fi

log "6. systemd unit"
sed -e "s#/opt/proof-market-maker#$APP_DIR#g" \
    -e "s/^User=.*/User=$SVC_USER/" \
    -e "s#ExecStart=.*#ExecStart=/usr/bin/npm run bot -- $MARKET#" \
    "$APP_DIR/deploy/proof-mm.service" > /etc/systemd/system/proof-mm.service
systemctl daemon-reload
systemctl enable --now proof-mm

if [ "$BOT_ONLY" != 1 ]; then
log "7. systemd unit — dashboard (loopback 127.0.0.1:3100)"
sed -e "s#/opt/proof-market-maker#$APP_DIR#g" \
    -e "s/^User=.*/User=$SVC_USER/" \
    "$APP_DIR/deploy/proof-dashboard.service" > /etc/systemd/system/proof-dashboard.service
systemctl daemon-reload
systemctl enable --now proof-dashboard
fi

log "8. optional public HTTPS for the dashboard (Caddy)"
if [ "$BOT_ONLY" != 1 ] && [ -n "$DASHBOARD_DOMAIN" ]; then
  [ -n "$ACME_EMAIL" ] || { echo "FATAL: DASHBOARD_DOMAIN set but ACME_EMAIL empty (Let's Encrypt needs it)"; exit 1; }
  if ! command -v caddy >/dev/null; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy
  fi
  # Reverse-proxy 443 -> the loopback dashboard. Caddy auto-provisions + renews TLS.
  sed -e "s#{{DOMAIN}}#$DASHBOARD_DOMAIN#g" -e "s#{{EMAIL}}#$ACME_EMAIL#g" \
      "$APP_DIR/deploy/aws/Caddyfile.template" > /etc/caddy/Caddyfile
  systemctl enable --now caddy
  systemctl reload caddy || systemctl restart caddy
  echo "dashboard public at: https://$DASHBOARD_DOMAIN (open 80+443 in the security group)"
elif [ "$BOT_ONLY" = 1 ]; then
  echo "BOT_ONLY=1 — no dashboard on this box (it lives on Vercel)"
else
  echo "dashboard is loopback-only; reach it via: ssh -L 3100:127.0.0.1:3100 <host>  then http://localhost:3100"
fi

if [ "$BOT_ONLY" = 1 ]; then
  log "9. status (follow with: journalctl -u proof-mm -f)"
  sleep 3
  systemctl is-active proof-mm \
    && echo "bootstrap OK — bot up; run deploy/PROVISION.md §5 acceptance test next"
else
  log "9. status (follow with: journalctl -u proof-mm -u proof-dashboard -f)"
  sleep 3
  systemctl is-active proof-mm && systemctl is-active proof-dashboard \
    && echo "bootstrap OK — both services up; run deploy/PROVISION.md §5 acceptance test next"
fi
