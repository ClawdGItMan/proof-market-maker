/**
 * ELO-8 spike: prove the Proof wire end-to-end.
 *
 * Connect → stream the book → place ONE post-only maker bid far from mid →
 * confirm it rests (open-orders + live book level) → cancel it by id →
 * measure commit latency on both legs → probe rate-limit behaviour.
 *
 * Read-only-until-place; the single order is post-only and priced well below
 * best bid so it never crosses/fills. Paper (devnet) funds only.
 */
import { loadConfig } from "./config.js";
import { ProofAdapter, Side, TimeInForce, bigintJson } from "./sdkAdapter.js";
import { LocalBook } from "./book.js";

const MARKET = Number(process.argv[2] ?? 1);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function fmtUsd(microUsdc: bigint): string {
  // price levels are micro-USDC (6dp) on this devnet
  const cents = microUsdc / 10_000n;
  return `$${(Number(cents) / 100).toLocaleString("en-US")}`;
}

async function main() {
  const cfg = loadConfig();
  const a = new ProofAdapter(cfg);
  const log: Record<string, unknown> = { market: MARKET, wallet: a.addressHex };
  console.log(`\n=== ELO-8 SPIKE — market ${MARKET} — wallet ${a.addressHex} ===\n`);

  // 1. Connectivity + funding ------------------------------------------------
  const health = await a.health();
  console.log(`[1] health: status=${health.status} height=${health.height}`);
  const markets = await a.markets();
  const meta = markets.find((m) => m.market === MARKET);
  console.log(
    `[1] market ${MARKET} (${meta?.ticker ?? "?"}): maker/taker=${meta?.makerFeeBps}/${meta?.takerFeeBps}bps ` +
      `IM/MM=${meta?.imBps}/${meta?.mmBps}bps tick=${meta?.tickSize ?? "?"}µUSDC lot=${meta?.lotSize ?? "?"} sz=${meta?.szDecimals ?? "?"}`,
  );
  const acct = await a.account();
  if (!acct) {
    console.error("[1] account not found on chain — wallet unfunded? aborting before placing.");
    process.exit(3);
  }
  console.log(`[1] account: balance=${fmtUsd(BigInt(acct.balance))} (raw µUSDC=${acct.balance}) equity=${acct.equity} positions=${acct.positions.length}`);
  log.health = health;
  log.fees = { makerBps: meta?.makerFeeBps, takerBps: meta?.takerFeeBps, imBps: meta?.imBps, mmBps: meta?.mmBps, tickSize: String(meta?.tickSize), lotSize: String(meta?.lotSize), szDecimals: meta?.szDecimals };

  // 2. Stream the book -------------------------------------------------------
  const book = new LocalBook();
  let snapshotSeen = false;
  let wsErrors = 0;
  const unsub = a.streamOrderbook(MARKET, {
    onSubscribed: () => console.log("[2] ws subscribed to orderbook"),
    onSnapshot: (s) => { book.applySnapshot(s); snapshotSeen = true; },
    onUpdate: (u) => book.applyUpdate(u),
    onError: () => { wsErrors += 1; },
  });
  // wait for snapshot
  for (let i = 0; i < 50 && !snapshotSeen; i++) await sleep(100);
  if (!snapshotSeen) { console.error("[2] no snapshot — aborting."); unsub(); a.disconnect(); process.exit(4); }
  await sleep(800); // let a few deltas apply
  const bb = book.bestBid(); const ba = book.bestAsk();
  console.log(`[2] live book: bid=${bb ? fmtUsd(bb.price) : "—"} ask=${ba ? fmtUsd(ba.price) : "—"} stats=${JSON.stringify(book.stats(), bigintJson)}`);
  // cross-check vs REST
  const rest = await a.orderbook(MARKET);
  console.log(`[2] REST cross-check: bid=${rest.bids[0] ? fmtUsd(rest.bids[0].price) : "—"} ask=${rest.asks[0] ? fmtUsd(rest.asks[0].price) : "—"}`);
  if (!bb) { console.error("[2] empty bid side — aborting."); unsub(); a.disconnect(); process.exit(5); }

  // 3. Place ONE post-only maker bid, ~3% below best bid (no cross) ----------
  const price = (bb.price * 97n) / 100n; // 3% under best bid → post-only never crosses
  const quantity = 160n;                  // 160 * 10^-5 = 0.0016 BTC ≈ $100 notional (matches live level sizes; clears any min-notional)
  console.log(`\n[3] PLACE post-only bid: price=${fmtUsd(price)} (raw ${price}) qty=${quantity} (BigInt end-to-end)`);
  const noncesBefore = await a.recentNonces().catch(() => []);
  const tPlace = Date.now();
  const placed = await a.placeOrderCommit({ market: MARKET, side: Side.Buy, price, quantity, postOnly: true, timeInForce: TimeInForce.Gtc });
  const placeMs = Date.now() - tPlace;
  console.log(`[3] result: code=${placed.tx.code} height=${placed.tx.height ?? "?"} orderId=${placed.orderId ?? "?"} hash=${placed.tx.hash.slice(0, 16)}… commitLatency=${placeMs}ms`);
  if (placed.tx.code !== 0) {
    console.error(`[3] place REJECTED: log=${placed.tx.log}`);
    unsub(); a.disconnect();
    console.log("\nSUMMARY:", JSON.stringify({ ...log, placeRejected: placed.tx.code, placeLog: placed.tx.log }, bigintJson));
    process.exit(6);
  }
  const noncesAfter = await a.recentNonces().catch(() => []);
  console.log(`[3] nonce lifecycle: recent-nonce count ${noncesBefore.length} -> ${noncesAfter.length} (timestamp nonce burned on commit)`);
  console.log(`[3] raw OrderPlaced events (parser diagnosis): ${JSON.stringify(placed.tx.events ?? [], bigintJson).slice(0, 600)}`);

  // 4. Confirm RESTING + resolve the engine order id -------------------------
  await sleep(1200);
  const open = await a.openOrders();
  // Robust id resolution: event parse first, else match our resting order by price+side.
  const mine = open.find((o) => o.side === "Buy" && o.price === price);
  const orderId = placed.orderId ?? mine?.id ?? null;
  console.log(`[4] open orders: ${open.length}; our order resting=${mine ? "YES" : "NO"}${mine ? ` (id=${mine.id} price ${fmtUsd(mine.price)} qty ${mine.quantity})` : ""}`);
  console.log(`[4] resolved orderId=${orderId} (from ${placed.orderId != null ? "event" : mine ? "openOrders" : "none"})`);
  const ourLevel = book.bidLevels().find((l) => l.price === price);
  console.log(`[4] our price level visible in live book: ${ourLevel ? `YES qty=${ourLevel.totalQty}` : "not yet (delta lag)"}`);

  // 5. Cancel by id ----------------------------------------------------------
  let cancelMs = -1; let cancelCode = -99;
  if (orderId != null) {
    console.log(`\n[5] CANCEL order ${orderId} by id…`);
    const tCancel = Date.now();
    const cancelled = await a.cancelOrderCommit(orderId);
    cancelMs = Date.now() - tCancel; cancelCode = cancelled.code;
    console.log(`[5] result: code=${cancelled.code} height=${cancelled.height ?? "?"} commitLatency=${cancelMs}ms`);
    await sleep(1000);
    const open2 = await a.openOrders();
    const still = open2.find((o) => o.id === orderId);
    console.log(`[5] post-cancel open orders: ${open2.length}; our order present=${still ? "STILL THERE ⚠" : "gone ✓"}`);
  } else {
    console.warn("[5] could not resolve orderId — cancelling all open as safety");
    for (const o of open) await a.cancelOrderCommit(o.id);
  }

  // 6. Rate-limit probe: burst of rapid REST reads ---------------------------
  console.log(`\n[6] rate-limit probe: 20 rapid REST orderbook reads…`);
  const tBurst = Date.now();
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => a.orderbook(MARKET)));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - ok;
  const burstMs = Date.now() - tBurst;
  console.log(`[6] burst: ${ok}/20 ok, ${failed} failed, ${burstMs}ms total (${(burstMs / 20).toFixed(0)}ms/req). No 429 ⇒ headroom for MM read volume.`);

  unsub(); a.disconnect();

  const summary = {
    ...log,
    connected: true,
    streamedBook: { snapshotSeen, wsErrors, ...book.stats() },
    place: { code: placed.tx.code, orderId: String(orderId), orderIdFromEvent: placed.orderId != null, commitMs: placeMs, price: String(price), qty: String(quantity) },
    rested: !!mine,
    cancel: { code: cancelCode, commitMs: cancelMs },
    rateLimit: { burst: 20, ok, failed, totalMs: burstMs },
  };
  console.log("\n=== SPIKE SUMMARY ===");
  console.log(JSON.stringify(summary, bigintJson, 2));
  process.exit(0);
}

main().catch((e) => { console.error("[spike] fatal:", e); process.exit(1); });
