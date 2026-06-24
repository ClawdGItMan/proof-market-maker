/**
 * Kill-switch CLI (ELO-10 two-tier). Two responsibilities:
 *
 *  1. Immediate atomic cancel-all (the original panic button), and
 *  2. Driving the bot's two-tier control file so the live process changes
 *     behaviour without a restart.
 *
 *   npm run killswitch              # cancel-all (all markets) + set control=hard
 *   npm run killswitch -- 1         # cancel-all on market 1 + set control=hard
 *   npm run killswitch -- soft      # pause: stop new quotes, keep resting orders
 *   npm run killswitch -- hard      # flatten + halt (cancel-all, then idle)
 *   npm run killswitch -- run       # resume normal quoting
 *
 * The control file (MM_CONTROL_FILE, default data/control) is the same one the
 * bot polls each tick, so a `soft`/`hard`/`run` flip takes effect within a tick.
 */
import { loadConfig } from "./config.js";
import { ProofAdapter } from "./sdkAdapter.js";
import { NonceManager, FileNonceStore } from "./nonceManager.js";
import { createLogger } from "./logger.js";
import { KillControl, type KillMode } from "./killControl.js";

const CONTROL_PATH = process.env.MM_CONTROL_FILE ?? "data/control";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg);
  const arg = process.argv[2];

  // Mode form: `killswitch -- soft|hard|run` just flips the control file.
  if (arg === "soft" || arg === "hard" || arg === "run") {
    new KillControl(CONTROL_PATH).set(arg as KillMode);
    log.warn({ mode: arg, control: CONTROL_PATH }, "kill-switch: control file set");
    if (arg !== "hard") {
      process.exit(0); // soft/run never touch the book directly
    }
    // fall through: hard also fires an immediate cancel-all below
  }

  const market = arg && /^\d+$/.test(arg) ? Number(arg) : undefined;

  // Any cancel-all invocation also latches the control file to `hard`, so a
  // restarting/looping bot won't immediately re-quote over the orders we just pulled.
  new KillControl(CONTROL_PATH).set("hard");

  const adapter = new ProofAdapter(cfg);
  const nonce = new NonceManager({ store: new FileNonceStore("data/nonce.state") });

  const before = (await adapter.openOrders()).filter((o) => market === undefined || o.market === market);
  log.warn({ market: market ?? "all", open: before.length }, "kill-switch: cancelling all");

  await nonce.gate();
  const r = await adapter.cancelAllOrdersCommit(market);
  log.info({ code: r.code, height: r.height ?? null }, "cancel-all committed");

  const after = (await adapter.openOrders()).filter((o) => market === undefined || o.market === market);
  log.info({ remaining: after.length }, after.length === 0 ? "all clear ✓" : "orders remain ⚠");
  adapter.disconnect();
  process.exit(after.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[killswitch] fatal:", e);
  process.exit(1);
});
