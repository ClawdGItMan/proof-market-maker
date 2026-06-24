/**
 * pm2 process manifest for the always-on market maker (ELO-10).
 *
 *   pm2 start deploy/ecosystem.config.cjs
 *   pm2 logs proof-mm
 *   pm2 save && pm2 startup     # survive host reboots
 *
 * pm2 restarts the bot on crash with exponential backoff. On restart the bot
 * runs `reconcileOnStartup()` (cancels orphan orders) before quoting, so a
 * crash + auto-restart leaves no orphan orders — the ELO-10 done-criterion.
 *
 * Secrets come from the gitignored .env via tsx's --env-file; pm2 never sees
 * PROOF_PRIVATE_KEY in its own env or logs.
 */
module.exports = {
  apps: [
    {
      name: "proof-mm",
      script: "npm",
      args: "run bot -- 1", // market 1 (BTC); change per deployment
      cwd: __dirname + "/..",
      autorestart: true,
      max_restarts: 50,
      restart_delay: 2000,
      exp_backoff_restart_delay: 200,
      // SIGINT lets bot.ts flatten quotes before exit; give it room to finish.
      kill_timeout: 10000,
      stop_exit_codes: [0],
      time: true,
      merge_logs: true,
      out_file: "data/pm2-out.log",
      error_file: "data/pm2-err.log",
    },
  ],
};
