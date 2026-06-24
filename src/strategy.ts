/**
 * Pluggable strategy interface (architecture §2) and a trivial fixed-spread
 * implementation.
 *
 * A `Strategy` is a pure function of market view + inventory → desired quotes.
 * It knows nothing about nonces, order ids, the wire, or how quotes are made to
 * rest — the executor/diff own all of that. Swapping in a smarter strategy
 * later is a one-file change behind this interface.
 *
 * Units: prices are µUSDC (6dp) BigInt; sizes are integer lots (10^-szDecimals
 * contracts). See ELO-8 spike notes.
 */
import type { DesiredQuote, Side } from "./diff.js";

const BUY: Side = 1;
const SELL: Side = 2;

export interface MarketView {
  /** Best resting bid price (µUSDC) or null if the bid side is empty. */
  bestBid: bigint | null;
  /** Best resting ask price (µUSDC) or null if the ask side is empty. */
  bestAsk: bigint | null;
  /** Midpoint (µUSDC), or null if the book is not two-sided. */
  mid: bigint | null;
}

export interface Inventory {
  /** Net signed position in lots: positive = long, negative = short. */
  net: bigint;
}

export interface Strategy {
  readonly name: string;
  /** Desired quotes for this tick. Empty array = quote nothing. */
  quote(view: MarketView, inv: Inventory): DesiredQuote[];
}

export interface FixedSpreadConfig {
  /** Half-spread per side, in basis points off the (inventory-skewed) mid. */
  spreadBps: bigint;
  /** Order size per side, in lots. */
  quoteSize: bigint;
  /** Absolute inventory cap (lots). At/over the cap we stop quoting the side
   *  that would grow the position further. */
  maxInventory: bigint;
  /** Optional: lean the mid against inventory. At full `maxInventory` the mid
   *  is shifted by this many bps, pushing quotes to flatten the position. */
  inventorySkewBps?: bigint;
  /** Optional tick size (µUSDC) to round prices to. 0/undefined = no rounding. */
  tickSize?: bigint;
}

const roundDownTo = (x: bigint, tick: bigint): bigint =>
  tick > 0n ? (x / tick) * tick : x;
const roundUpTo = (x: bigint, tick: bigint): bigint =>
  tick > 0n ? ((x + tick - 1n) / tick) * tick : x;

/**
 * Symmetric fixed-spread maker with basic inventory management:
 *  - quotes a bid and an ask `spreadBps` off the mid,
 *  - skews the mid against the current net position (optional), and
 *  - suppresses the side that would push inventory past `maxInventory`.
 * Prices are clamped so quotes never cross the live book (post-only safety).
 */
export class FixedSpreadStrategy implements Strategy {
  readonly name = "fixed-spread";
  constructor(private readonly cfg: FixedSpreadConfig) {}

  quote(view: MarketView, inv: Inventory): DesiredQuote[] {
    const { mid, bestBid, bestAsk } = view;
    if (mid === null) return []; // one-sided/empty book → don't quote

    const { spreadBps, quoteSize, maxInventory } = this.cfg;
    const tick = this.cfg.tickSize ?? 0n;
    const skewBps = this.cfg.inventorySkewBps ?? 0n;

    // Inventory skew: long → lower fair value (lean to sell), short → raise it.
    const skew =
      skewBps > 0n && maxInventory > 0n
        ? (mid * skewBps * inv.net) / (10_000n * maxInventory)
        : 0n;
    const fair = mid - skew;
    const half = (fair * spreadBps) / 10_000n;

    let bid = roundDownTo(fair - half, tick);
    let ask = roundUpTo(fair + half, tick);

    // Post-only safety: never lock/cross the visible book.
    const step = tick > 0n ? tick : 1n;
    if (bestAsk !== null && bid >= bestAsk) bid = bestAsk - step;
    if (bestBid !== null && ask <= bestBid) ask = bestBid + step;

    const quotes: DesiredQuote[] = [];
    // Quote the bid unless we're already at/over the long cap.
    if (inv.net < maxInventory && bid > 0n) {
      quotes.push({ side: BUY, price: bid, quantity: quoteSize });
    }
    // Quote the ask unless we're already at/over the short cap.
    if (inv.net > -maxInventory) {
      quotes.push({ side: SELL, price: ask, quantity: quoteSize });
    }
    return quotes;
  }
}
