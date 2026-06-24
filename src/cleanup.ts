/** Safety net: cancel every resting order for our wallet on a market. */
import { loadConfig } from "./config.js";
import { ProofAdapter, bigintJson } from "./sdkAdapter.js";

const MARKET = Number(process.argv[2] ?? 1);
async function main() {
  const a = new ProofAdapter(loadConfig());
  const open = await a.openOrders();
  console.log(`[cleanup] ${open.length} open order(s): ${JSON.stringify(open, bigintJson)}`);
  for (const o of open) {
    const r = await a.cancelOrderCommit(o.id);
    console.log(`[cleanup] cancel id=${o.id} -> code=${r.code} height=${r.height ?? "?"}`);
  }
  const after = await a.openOrders();
  console.log(`[cleanup] remaining: ${after.length}`);
  a.disconnect();
  process.exit(after.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
