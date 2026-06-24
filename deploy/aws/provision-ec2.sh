#!/usr/bin/env bash
# One-command AWS EC2 provisioner for the Proof market maker + ops dashboard (ELO-24).
#
# Board decision ELO-20: consolidate on AWS (drop Hetzner + Vercel). This script
# stands up a single t3.small box that runs BOTH the always-on bot and the Next.js
# dashboard (co-located, see deploy/bootstrap.sh), then hands off to the in-box
# bootstrap. Idempotent: re-running reuses the key pair / security group / instance
# (matched by Name tag) instead of creating duplicates.
#
# PREREQUISITES (the human-only blocker on ELO-24 / ELO-20):
#   - AWS CLI v2 installed and authenticated with EC2 permissions:
#       aws configure         # or export AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
#   - The two secret files present locally (never committed):
#       ./.env                      (PROOF_PRIVATE_KEY / PROOF_ADDRESS)
#       ./dashboard/.env.local      (operator Basic-Auth creds + Supabase keys; see dashboard/.env.example)
#
# USAGE (run from the repo root):
#   OPERATOR_IP=$(curl -s ifconfig.me) deploy/aws/provision-ec2.sh
#
# Optional public HTTPS for the dashboard instead of an SSH tunnel:
#   OPERATOR_IP=... DASHBOARD_DOMAIN=ops.example.com ACME_EMAIL=you@example.com deploy/aws/provision-ec2.sh
set -euo pipefail

# ---- config (override via env) ------------------------------------------------
REGION="${AWS_REGION:-us-east-1}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.small}"
NAME="${NAME:-proof-market-maker}"           # Name tag — also the idempotency key
KEY_NAME="${KEY_NAME:-proof-mm}"             # EC2 key pair name
KEY_FILE="${KEY_FILE:-$HOME/.ssh/${KEY_NAME}.pem}"
SG_NAME="${SG_NAME:-proof-mm-sg}"
VOLUME_GB="${VOLUME_GB:-20}"
APP_DIR="${APP_DIR:-/opt/proof-market-maker}"
SSH_USER="ubuntu"                            # default user on the Ubuntu AMI
DASHBOARD_DOMAIN="${DASHBOARD_DOMAIN:-}"
ACME_EMAIL="${ACME_EMAIL:-}"

log() { printf '\n=== %s ===\n' "$1"; }
aws_() { aws --region "$REGION" "$@"; }

# ---- preflight ----------------------------------------------------------------
command -v aws >/dev/null || { echo "FATAL: aws CLI not found — install AWS CLI v2"; exit 1; }
aws_ sts get-caller-identity >/dev/null 2>&1 || { echo "FATAL: AWS creds not configured/authorized (the ELO-20 blocker). Run 'aws configure'."; exit 1; }
[ -n "${OPERATOR_IP:-}" ] || { echo "FATAL: set OPERATOR_IP to your public IP (SSH ingress is locked to it). e.g. OPERATOR_IP=\$(curl -s ifconfig.me)"; exit 1; }
[ -s ./.env ] || { echo "FATAL: ./.env missing (PROOF_PRIVATE_KEY). Create it before provisioning."; exit 1; }
# BOT_ONLY=1 (ELO-26): provision ONLY the bot; the ops dashboard stays on Vercel.
BOT_ONLY="${BOT_ONLY:-0}"
if [ "$BOT_ONLY" != 1 ]; then
  [ -s ./dashboard/.env.local ] || { echo "FATAL: ./dashboard/.env.local missing (operator creds + Supabase keys). See dashboard/.env.example."; exit 1; }
fi
if [ -n "$DASHBOARD_DOMAIN" ] && [ -z "$ACME_EMAIL" ]; then echo "FATAL: DASHBOARD_DOMAIN set but ACME_EMAIL empty"; exit 1; fi

# ---- 1. key pair --------------------------------------------------------------
log "1. key pair ($KEY_NAME)"
if ! aws_ ec2 describe-key-pairs --key-names "$KEY_NAME" >/dev/null 2>&1; then
  mkdir -p "$(dirname "$KEY_FILE")"
  aws_ ec2 create-key-pair --key-name "$KEY_NAME" --query 'KeyMaterial' --output text > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  echo "created key pair -> $KEY_FILE"
else
  echo "key pair exists; assuming private key at $KEY_FILE"
  [ -f "$KEY_FILE" ] || { echo "FATAL: AWS has key pair '$KEY_NAME' but $KEY_FILE is missing locally — cannot SSH. Delete the AWS key or restore the .pem."; exit 1; }
fi

# ---- 2. security group --------------------------------------------------------
log "2. security group ($SG_NAME)"
SG_ID=$(aws_ ec2 describe-security-groups --filters "Name=group-name,Values=$SG_NAME" \
          --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID=$(aws_ ec2 create-security-group --group-name "$SG_NAME" \
            --description "Proof MM bot + dashboard" --query 'GroupId' --output text)
  echo "created $SG_ID"
fi
# SSH locked to the operator IP only. authorize is idempotent enough — ignore "already exists".
aws_ ec2 authorize-security-group-ingress --group-id "$SG_ID" \
  --protocol tcp --port 22 --cidr "${OPERATOR_IP}/32" 2>/dev/null || true
if [ -n "$DASHBOARD_DOMAIN" ]; then
  # Public HTTPS mode: Caddy needs 80 (ACME challenge) + 443 from anywhere.
  for p in 80 443; do
    aws_ ec2 authorize-security-group-ingress --group-id "$SG_ID" \
      --protocol tcp --port "$p" --cidr 0.0.0.0/0 2>/dev/null || true
  done
  echo "opened 22 (operator), 80+443 (public HTTPS)"
else
  echo "opened 22 (operator) only — dashboard stays on a loopback + SSH tunnel"
fi

# ---- 3. latest Ubuntu 24.04 AMI (from the public SSM parameter) ---------------
log "3. resolve Ubuntu 24.04 LTS AMI"
AMI_ID=$(aws_ ssm get-parameters \
  --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query 'Parameters[0].Value' --output text)
echo "AMI: $AMI_ID"

# ---- 4. launch (or reuse) the instance ----------------------------------------
log "4. instance ($NAME, $INSTANCE_TYPE)"
IID=$(aws_ ec2 describe-instances \
  --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo "None")
if [ "$IID" = "None" ] || [ -z "$IID" ]; then
  IID=$(aws_ ec2 run-instances \
    --image-id "$AMI_ID" --instance-type "$INSTANCE_TYPE" --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$VOLUME_GB,VolumeType=gp3}" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
    --query 'Instances[0].InstanceId' --output text)
  echo "launched $IID"
else
  echo "reusing existing instance $IID"
  aws_ ec2 start-instances --instance-ids "$IID" >/dev/null 2>&1 || true
fi
aws_ ec2 wait instance-status-ok --instance-ids "$IID"
PUBLIC_IP=$(aws_ ec2 describe-instances --instance-ids "$IID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "instance ready at $PUBLIC_IP"

SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -i $KEY_FILE"
ssh_() { ssh $SSH_OPTS "${SSH_USER}@${PUBLIC_IP}" "$@"; }

# ---- 5. ship the repo (no .git, no node_modules; secrets handled separately) ---
log "5. sync repo -> $APP_DIR"
ssh_ "sudo mkdir -p '$APP_DIR' && sudo chown ${SSH_USER} '$APP_DIR'"
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude 'dashboard/node_modules' \
  --exclude 'dashboard/.next' --exclude 'dashboard/.vercel' --exclude '.tmp' --exclude 'data' \
  -e "ssh $SSH_OPTS" ./ "${SSH_USER}@${PUBLIC_IP}:${APP_DIR}/"

# ---- 6. inject secrets out-of-band (never echoed, never committed) -------------
log "6. inject secrets (.env$([ "$BOT_ONLY" != 1 ] && echo ', dashboard/.env.local'))"
scp $SSH_OPTS ./.env "${SSH_USER}@${PUBLIC_IP}:${APP_DIR}/.env"
if [ "$BOT_ONLY" != 1 ]; then
  ssh_ "mkdir -p '${APP_DIR}/dashboard'"
  scp $SSH_OPTS ./dashboard/.env.local "${SSH_USER}@${PUBLIC_IP}:${APP_DIR}/dashboard/.env.local"
fi

# ---- 7. run the in-box bootstrap (installs Node 22, NTP, systemd unit(s)) ------
log "7. bootstrap host"
ssh_ "sudo APP_DIR='$APP_DIR' BOT_ONLY='$BOT_ONLY' DASHBOARD_DOMAIN='$DASHBOARD_DOMAIN' ACME_EMAIL='$ACME_EMAIL' bash '$APP_DIR/deploy/bootstrap.sh'"

log "DONE"
echo "instance:  $IID  ($PUBLIC_IP)"
echo "bot logs:  ssh -i $KEY_FILE ${SSH_USER}@${PUBLIC_IP} 'journalctl -u proof-mm -f'"
if [ "$BOT_ONLY" = 1 ]; then
  echo "dashboard: stays on Vercel (not provisioned here, per ELO-26)"
elif [ -n "$DASHBOARD_DOMAIN" ]; then
  echo "dashboard: https://$DASHBOARD_DOMAIN  (point this DNS A record at $PUBLIC_IP)"
else
  echo "dashboard: ssh -i $KEY_FILE -L 3100:127.0.0.1:3100 ${SSH_USER}@${PUBLIC_IP}   then open http://localhost:3100"
fi
echo "Next: run the crash-recovery acceptance test in deploy/PROVISION.md §5."
