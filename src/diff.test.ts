import { describe, it, expect } from "vitest";
import { diffQuotes, type DesiredQuote, type RestingOrder } from "./diff.js";

const BUY = 1 as const; // Side.Buy
const SELL = 2 as const; // Side.Sell

const desired = (side: 1 | 2, price: bigint, quantity: bigint): DesiredQuote => ({
  side,
  price,
  quantity,
});
const resting = (id: bigint, side: 1 | 2, price: bigint, quantity: bigint): RestingOrder => ({
  id,
  side,
  price,
  quantity,
});

describe("diffQuotes", () => {
  it("places both sides when nothing is resting", () => {
    const actions = diffQuotes(
      [desired(BUY, 100n, 10n), desired(SELL, 110n, 10n)],
      [],
    );
    expect(actions).toEqual([
      { kind: "place", side: BUY, price: 100n, quantity: 10n },
      { kind: "place", side: SELL, price: 110n, quantity: 10n },
    ]);
  });

  it("is a no-op when resting already matches desired exactly", () => {
    const actions = diffQuotes(
      [desired(BUY, 100n, 10n), desired(SELL, 110n, 10n)],
      [resting(1n, BUY, 100n, 10n), resting(2n, SELL, 110n, 10n)],
    );
    expect(actions).toEqual([]);
  });

  it("treats sub-tolerance price drift as a no-op (no churn)", () => {
    const actions = diffQuotes(
      [desired(BUY, 100n, 10n)],
      [resting(1n, BUY, 102n, 10n)],
      { priceTolerance: 5n },
    );
    expect(actions).toEqual([]);
  });

  it("cancel-replaces when price drifts beyond tolerance", () => {
    const actions = diffQuotes(
      [desired(BUY, 100n, 10n)],
      [resting(1n, BUY, 90n, 10n)],
      { priceTolerance: 5n },
    );
    expect(actions).toEqual([
      { kind: "cancelReplace", id: 1n, side: BUY, price: 100n, quantity: 10n },
    ]);
  });

  it("cancel-replaces when only the quantity changes beyond tolerance", () => {
    const actions = diffQuotes(
      [desired(BUY, 100n, 20n)],
      [resting(1n, BUY, 100n, 10n)],
    );
    expect(actions).toEqual([
      { kind: "cancelReplace", id: 1n, side: BUY, price: 100n, quantity: 20n },
    ]);
  });

  it("cancels a resting order when its side is no longer desired (inventory cap)", () => {
    const actions = diffQuotes(
      [desired(SELL, 110n, 10n)], // bid suppressed because we're too long
      [resting(1n, BUY, 100n, 10n), resting(2n, SELL, 110n, 10n)],
    );
    expect(actions).toEqual([{ kind: "cancel", id: 1n }]);
  });

  it("cancels everything when desired is empty (kill / book gone stale)", () => {
    const actions = diffQuotes(
      [],
      [resting(1n, BUY, 100n, 10n), resting(2n, SELL, 110n, 10n)],
    );
    expect(actions).toEqual([
      { kind: "cancel", id: 1n },
      { kind: "cancel", id: 2n },
    ]);
  });

  it("keeps one order per side and cancels stray duplicates", () => {
    const actions = diffQuotes(
      [desired(BUY, 100n, 10n)],
      [resting(1n, BUY, 100n, 10n), resting(2n, BUY, 99n, 10n)],
    );
    // order 1 already matches → no-op; the duplicate order 2 is cancelled.
    expect(actions).toEqual([{ kind: "cancel", id: 2n }]);
  });
});
