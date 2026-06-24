/**
 * Order lifecycle tracker: submitted → committed → resting → filled / cancelled.
 *
 * The exchange is the source of truth for what's resting (we read open orders
 * each tick), so the tracker's job is the *transitions the read can't tell you*:
 *  - which order ids we put on the book and their intended price/size,
 *  - which we deliberately cancelled (so their disappearance isn't a "fill"),
 *  - and, by reconciling against the live resting set, which orders vanished
 *    *without* us cancelling them — i.e. inferred fills (used for inventory and
 *    structured fill logs).
 *
 * Keys are `id.toString()` because BigInt can't key a Map by value.
 */
import type { RestingOrder, Side } from "./diff.js";

export type OrderState = "submitted" | "resting" | "filled" | "cancelled";

export interface TrackedOrder {
  id: bigint;
  side: Side;
  price: bigint;
  quantity: bigint;
  state: OrderState;
  placedAt: number;
  updatedAt: number;
}

export class OrderTracker {
  private readonly orders = new Map<string, TrackedOrder>();
  constructor(private readonly clock: () => number = Date.now) {}

  /** Record an order we just committed onto the book. */
  onResting(o: { id: bigint; side: Side; price: bigint; quantity: bigint }): void {
    const now = this.clock();
    const existing = this.orders.get(o.id.toString());
    this.orders.set(o.id.toString(), {
      id: o.id,
      side: o.side,
      price: o.price,
      quantity: o.quantity,
      state: "resting",
      placedAt: existing?.placedAt ?? now,
      updatedAt: now,
    });
  }

  /** Mark an order we deliberately cancelled, so reconcile won't call it a fill. */
  onCancelled(id: bigint): void {
    const o = this.orders.get(id.toString());
    if (o) {
      o.state = "cancelled";
      o.updatedAt = this.clock();
    }
  }

  /** Currently-resting orders we know about. */
  resting(): TrackedOrder[] {
    return [...this.orders.values()].filter((o) => o.state === "resting");
  }

  byId(id: bigint): TrackedOrder | undefined {
    return this.orders.get(id.toString());
  }

  /**
   * Reconcile against the exchange's live resting set. Any order we believed
   * resting that is now absent (and that we did NOT cancel) is inferred filled.
   * Returns the inferred fills so the caller can update inventory / log them.
   */
  reconcile(live: RestingOrder[]): { fills: TrackedOrder[] } {
    const liveIds = new Set(live.map((o) => o.id.toString()));
    const fills: TrackedOrder[] = [];
    for (const o of this.orders.values()) {
      if (o.state === "resting" && !liveIds.has(o.id.toString())) {
        o.state = "filled";
        o.updatedAt = this.clock();
        fills.push(o);
      }
    }
    // Adopt any resting orders the exchange shows that we aren't tracking yet
    // (e.g. recovered after a restart) so the diff/cancel paths can see them.
    for (const o of live) {
      if (!this.orders.has(o.id.toString())) this.onResting(o);
    }
    return { fills };
  }

  /** Drop terminal orders so the map doesn't grow unbounded. */
  prune(): void {
    for (const [k, o] of this.orders) {
      if (o.state === "filled" || o.state === "cancelled") this.orders.delete(k);
    }
  }
}
