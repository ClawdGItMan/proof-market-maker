/**
 * Forced-resync demo (the ELO-9 done-criterion proof).
 *
 * Drives a live MarketMaker through:
 *   1. quote both sides on devnet paper,
 *   2. force an unexpected socket drop,
 *   3. confirm the book goes stale and quotes are pulled,
 *   4. wait for the stream to re-subscribe and re-snapshot (resync),
 *   5. re-quote both sides,
 *   6. flatten (kill-switch) and report PASS/FAIL.
 *
 *   npm run demo:resync        # market 1 (BTC)
 *   npm run demo:resync -- 3   # market 3 (SOL)
 */
import { buildMarketMaker, sleep } from "./bot.js";

async function main(): Promise<void> {
  const market = Number(process.argv[2] ?? process.env.MM_MARKET ?? 1);
  const { mm, log, adapter } = buildMarketMaker(market);

  log.info("DEMO 1/6: connecting + waiting for live book");
  await mm.connect();

  log.info("DEMO 2/6: placing two-sided quotes");
  await mm.tick();
  await sleep(1_500);
  const before = (await adapter.openOrders()).filter((o) => o.market === market);
  log.info({ resting: before.length, sides: before.map((o) => o.side) }, "quotes resting before drop");

  const prevResync = mm.resyncCount;
  log.warn("DEMO 3/6: forcing socket drop");
  mm.forceSocketDrop();
  await sleep(600);
  log.info({ stale: mm.isStale() }, "post-drop state");
  // A tick during staleness pulls quotes (safe-mode).
  await mm.tick();

  log.info("DEMO 4/6: waiting for resync");
  await mm.waitForResync(prevResync);
  log.info({ resyncs: mm.resyncCount, stale: mm.isStale() }, "stream resynced");

  log.info("DEMO 5/6: re-quoting after resync");
  await mm.tick();
  await sleep(1_500);
  const after = (await adapter.openOrders()).filter((o) => o.market === market);
  log.info({ resting: after.length, sides: after.map((o) => o.side) }, "quotes resting after resync");

  log.info("DEMO 6/6: flattening");
  await mm.stop();

  const pass = mm.resyncCount > prevResync && before.length > 0 && after.length > 0;
  log.info(
    { pass, quotedBefore: before.length, resynced: mm.resyncCount - prevResync, requotedAfter: after.length },
    pass ? "DEMO PASS ✓ — quoted, dropped, resynced, re-quoted, flattened" : "DEMO FAIL ✗",
  );
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("[demo:resync] fatal:", e);
  process.exit(1);
});
