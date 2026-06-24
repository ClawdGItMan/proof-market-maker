import type { SnapshotFrameT, UpdateFrameT } from "./schemas.js";

/**
 * A local L2 order book rebuilt from a gateway snapshot + a stream of
 * single-level deltas. Prices/quantities are BigInt (micro-USDC / contracts).
 *
 * Delta semantics (observed live): each `update` frame is the new absolute
 * state of one price level on one side. totalQuantity === 0 removes the level.
 */
export interface Level {
  price: bigint;
  totalQty: bigint;
  orderCount: number;
}

export class LocalBook {
  /** price(string) -> Level. Keyed by decimal string because BigInt can't key a Map by value. */
  private bids = new Map<string, Level>();
  private asks = new Map<string, Level>();
  private lastUpdateAt = 0;
  private updates = 0;

  applySnapshot(s: SnapshotFrameT): void {
    this.bids = new Map(s.bids.map((l) => [l.price.toString(), l]));
    this.asks = new Map(s.asks.map((l) => [l.price.toString(), l]));
    this.lastUpdateAt = Date.now();
  }

  applyUpdate(u: UpdateFrameT): void {
    const side = u.side === "buy" ? this.bids : this.asks;
    const key = u.price.toString();
    if (u.totalQuantity === 0n) {
      side.delete(key);
    } else {
      side.set(key, { price: u.price, totalQty: u.totalQuantity, orderCount: u.orderCount });
    }
    this.lastUpdateAt = Date.now();
    this.updates += 1;
  }

  /** Bids sorted best (highest price) first. */
  bidLevels(): Level[] {
    return [...this.bids.values()].sort((a, b) => (b.price > a.price ? 1 : b.price < a.price ? -1 : 0));
  }
  /** Asks sorted best (lowest price) first. */
  askLevels(): Level[] {
    return [...this.asks.values()].sort((a, b) => (a.price > b.price ? 1 : a.price < b.price ? -1 : 0));
  }
  bestBid(): Level | undefined {
    return this.bidLevels()[0];
  }
  bestAsk(): Level | undefined {
    return this.askLevels()[0];
  }
  /** True if best bid >= best ask — a crossed/locked book, signals desync. */
  isCrossed(): boolean {
    const b = this.bestBid();
    const a = this.bestAsk();
    return !!b && !!a && b.price >= a.price;
  }
  stats() {
    return {
      bidLevels: this.bids.size,
      askLevels: this.asks.size,
      updatesApplied: this.updates,
      lastUpdateAgeMs: this.lastUpdateAt ? Date.now() - this.lastUpdateAt : null,
      crossed: this.isCrossed(),
    };
  }
}
