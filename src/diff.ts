/**
 * Execution diff: reconcile the strategy's *desired* quotes against the orders
 * actually *resting* on the exchange, and emit the minimal set of actions to
 * converge them — choosing **CancelReplace / Place / Cancel** per the ELO-9
 * spec.
 *
 * Pure and SDK-free on purpose: this is the second unit-tested core, and
 * keeping it free of the vendored SDK keeps the tests instant and the logic
 * auditable. `Side` here is the same numeric encoding the SDK uses
 * (Buy = 1, Sell = 2); the executor casts to the SDK enum at the call boundary.
 *
 * MVP invariant: at most one quote per side. Any extra resting orders on a side
 * (e.g. a half-applied replace, or a manual order) are cancelled so the book
 * converges to exactly the strategy's intent.
 */
export type Side = 1 | 2;

export interface DesiredQuote {
  side: Side;
  price: bigint;
  quantity: bigint;
}

export interface RestingOrder {
  id: bigint;
  side: Side;
  price: bigint;
  quantity: bigint;
}

export type DiffAction =
  | { kind: "place"; side: Side; price: bigint; quantity: bigint }
  | { kind: "cancel"; id: bigint }
  | { kind: "cancelReplace"; id: bigint; side: Side; price: bigint; quantity: bigint };

export interface DiffOpts {
  /** Prices within this many µUSDC count as equal → no replace churn. Default 0 (exact). */
  priceTolerance?: bigint;
  /** Quantities within this many lots count as equal. Default 0 (exact). */
  qtyTolerance?: bigint;
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

const SIDES: Side[] = [1, 2];

/**
 * Compute the actions that move `resting` to match `desired`.
 *
 * Per side:
 *   - desired, and a resting order already matches (within tolerance) → no-op
 *     for that order; cancel any duplicate resting orders on the side.
 *   - desired, but no match → CancelReplace the first resting order if one
 *     exists (atomic, keeps a quote live), else Place; cancel any extras.
 *   - no desired → Cancel every resting order on the side.
 *
 * Sides are processed Buy then Sell for deterministic, testable output.
 */
export function diffQuotes(
  desired: DesiredQuote[],
  resting: RestingOrder[],
  opts: DiffOpts = {},
): DiffAction[] {
  const priceTol = opts.priceTolerance ?? 0n;
  const qtyTol = opts.qtyTolerance ?? 0n;
  const matches = (o: RestingOrder, d: DesiredQuote): boolean =>
    abs(o.price - d.price) <= priceTol && abs(o.quantity - d.quantity) <= qtyTol;

  const actions: DiffAction[] = [];

  for (const side of SIDES) {
    const rs = resting.filter((o) => o.side === side);
    const d = desired.find((q) => q.side === side);

    if (!d) {
      // Side not desired → cancel anything resting there.
      for (const o of rs) actions.push({ kind: "cancel", id: o.id });
      continue;
    }

    // Prefer an already-matching order as the "keeper" to avoid needless churn.
    const keeperIdx = rs.findIndex((o) => matches(o, d));
    if (keeperIdx >= 0) {
      // Keep the matching order untouched; cancel every other resting order.
      rs.forEach((o, i) => {
        if (i !== keeperIdx) actions.push({ kind: "cancel", id: o.id });
      });
      continue;
    }

    // No match. Replace the first resting order (atomic) or place fresh.
    const [primary, ...extras] = rs;
    if (primary) {
      actions.push({
        kind: "cancelReplace",
        id: primary.id,
        side,
        price: d.price,
        quantity: d.quantity,
      });
    } else {
      actions.push({ kind: "place", side, price: d.price, quantity: d.quantity });
    }
    for (const o of extras) actions.push({ kind: "cancel", id: o.id });
  }

  return actions;
}
