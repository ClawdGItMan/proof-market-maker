/**
 * Probe: read-only connectivity check. Connects to devnet, prints health +
 * markets + REST top-of-book, then streams the live orderbook into a LocalBook
 * for a few seconds and prints reconstructed top-of-book. Places no orders.
 */
import { loadConfig } from "./config.js";
import { ProofAdapter, bigintJson } from "./sdkAdapter.js";
import { LocalBook } from "./book.js";

const MARKET = Number(process.argv[2] ?? 1);

async function main() {
  const cfg = loadConfig();
  const a = new ProofAdapter(cfg);
  console.log(`[probe] gateway=${cfg.gatewayUrl} chain=${cfg.chainId} wallet=${a.addressHex}`);
  console.log(`[probe] health: ${JSON.stringify(await a.health())}`);

  const markets = await a.markets();
  const m = markets.find((x) => x.market === MARKET);
  console.log(`[probe] markets=${markets.length}; market ${MARKET} = ${m?.ticker ?? "?"}`);
  if (m)
    console.log(
      `[probe]   fees maker/taker=${m.makerFeeBps}/${m.takerFeeBps}bps  IM/MM=${m.imBps}/${m.mmBps}bps  ` +
        `tickSize=${m.tickSize ?? "?"}µUSDC lotSize=${m.lotSize ?? "?"} szDecimals=${m.szDecimals ?? "?"}`,
    );

  const ob = await a.orderbook(MARKET);
  console.log(
    `[probe] REST top: bid=${JSON.stringify(ob.bids[0] ?? null, bigintJson)} ask=${JSON.stringify(ob.asks[0] ?? null, bigintJson)}`,
  );

  const book = new LocalBook();
  let snapshotSeen = false;
  const unsub = a.streamOrderbook(MARKET, {
    onSubscribed: () => console.log("[probe] ws subscribed"),
    onSnapshot: (s) => {
      book.applySnapshot(s);
      snapshotSeen = true;
      console.log(`[probe] snapshot: ${s.bids.length} bids / ${s.asks.length} asks`);
    },
    onUpdate: (u) => book.applyUpdate(u),
    onError: (e) => console.error(`[probe] ws error: ${String(e)}`),
  });

  setTimeout(() => {
    const bb = book.bestBid();
    const ba = book.bestAsk();
    console.log(
      `[probe] LIVE book top: bid=${bb ? JSON.stringify(bb, bigintJson) : "—"} ask=${ba ? JSON.stringify(ba, bigintJson) : "—"} stats=${JSON.stringify(book.stats(), bigintJson)}`,
    );
    unsub();
    a.disconnect();
    process.exit(snapshotSeen ? 0 : 2);
  }, 5000);
}

main().catch((e) => {
  console.error("[probe] fatal:", e);
  process.exit(1);
});
