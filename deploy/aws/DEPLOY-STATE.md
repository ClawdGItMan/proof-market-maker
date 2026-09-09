# AWS EC2 Deploy State — Proof Market Maker bot (ELO-26)

Provisioned 2026-06-24. The always-on paper-trading bot runs here.

## Resources (us-east-1, account <aws-account-id>)
- EC2 instance: `<instance-id>` (t3.micro, Ubuntu 24.04, AMI am<instance-id>)
- Key pair: `proof-mm` (private key at operator `~/.ssh/proof-mm.pem`)
- Security group: `<security-group-id>` — inbound 22 from operator IP only; dashboard NOT exposed (stays on Vercel)
- App dir: `/opt/proof-market-maker`, service user `proofmm`
- systemd unit: `proof-mm.service` (enabled, Restart=always, After=time-sync.target)

## Cost guardrail
- AWS Budget `proof-mm-monthly-50` — $50/mo, email alerts to <alert-email>
  at 50% / 80% (ACTUAL) and 100% (FORECASTED).

## Verified
- Node v22.23.0, NTP synced (chrony active; timesyncd inactive), bot connects → book live → two-sided quoting → places orders.
- Reboot survival: `sudo systemctl reboot` → new boot_id, service auto-started (enabled), resumed quoting
  (single clean "two-sided quoting started", no crash loop). NTP showed `no` for a few seconds at boot
  then converged within ~45s via chrony; zero nonce/timestamp/clock errors in the post-boot journal.
- Current public IP (ephemeral, no Elastic IP): <public-ip> — re-query on each reboot/stop;
  the SSH security-group rule is pinned to the operator IP, not the instance IP.

## Operate
- Logs: `ssh -i ~/.ssh/proof-mm.pem ubuntu@<ip> 'sudo journalctl -u proof-mm -f'`
- Redeploy: rsync repo to /opt/proof-market-maker, then `sudo APP_DIR=/opt/proof-market-maker BOT_ONLY=1 bash deploy/bootstrap.sh` (idempotent).

## Reliability patch fold-in — DONE (2026-06-24, ELO-30)
- Release-eng flag (ELO-30): the originally-deployed commit `e7881c6` was MISSING the
  ELO-16 freeze-recovery fix `c447e00` (watchdog freeze → forceSocketDrop()/resubscribe +
  startup reconcile re-queries openOrders() and refuses to quote on surviving orphans).
  Confirmed missing on the box by content grep (old log string present, new markers + chaos.test.ts absent).
- Folded in via `git cherry-pick -x c447e00` onto `feature/elo24-aws-deploy` (→ `a98ae4a`),
  chaos suite green (3/3), rsynced to the box and `systemctl restart proof-mm`.
- Post-redeploy verified: new markers present in `/opt/proof-market-maker/src/bot.ts`
  (`forcing resubscribe`, `refusing to quote on top of orphans`, `this.forceSocketDrop()` in the
  freeze block), old string gone, single clean startup (`NRestarts=0`, reconcile→no orphans→two-sided quoting).
  The kill-switch fix `8ac89ed` was already on the deploy line (unaffected).

## IAM scope reduction — DONE (2026-06-24)
- The supplied `proof-bot-deployer` key was narrowed from `AdministratorAccess` to a scoped set:
  `AmazonEC2FullAccess` + `AmazonSSMReadOnlyAccess` (AMI resolution) + `AWSBudgetsReadOnlyAccess`
  (so budget reads survive — avoids the self-lockout on cost visibility).
- Verified post-detach: `iam:ListUsers`, `iam:GetUser`, `s3:ListAllMyBuckets` → AccessDenied;
  `ec2:DescribeInstances` and `budgets:DescribeBudget` still succeed.
- CAVEAT (irreversible by this key): EC2-only can no longer modify IAM, so re-widening the key
  requires the AWS **root** account / another admin. EC2FullAccess on a leaked key can still spin
  up costly fleets — the `proof-mm-monthly-50` budget is the backstop for that. Operator declined
  key rotation; rotating remains the only way to fully neutralize the historical exposure.
