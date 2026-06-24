/**
 * PnL accumulator (ELO-13 dashboard).
 *
 * The bot tracks net position and infers fills, but nothing computed PnL before
 * this. We use the standard cash-flow + mark identity:
 *
 *   - every fill moves signed CASH: a BUY pays out (cash -= price·qty), a SELL
 *     takes in (cash += price·qty), and the net POSITION moves the other way;
 *   - total PnL marked at a reference price `mid` is simply `cash + position·mid`.
 *
 * When the book is flat (position 0) that collapses to pure *realized* cash; with
 * inventory on the book it folds in the *unrealized* mark in one expression, so
 * there is no separate realized/unrealized ledger to drift apart.
 *
 * Honest-about-limits: fills here are the bot's *inferred* fills (an order we
 * believed resting that vanished without us cancelling it — see OrderTracker),
 * not exchange-confirmed prints, and the mark is the current mid. So the number
 * is a maker's running estimate, and the dashboard must label it as such.
 *
 * Pure and integer-only (µUSDC prices × integer lots) — unit-tested without I/O.
 */
import type { Side } from "./diff.js";

const BUY: Side = 1;

export interface PnlSnapshot {
  /** Net signed position in lots: positive = long, negative = short. */
  position: bigint;
  /** Cumulative signed cash from fills (µUSDC·lots units), pre-mark. */
  cashFlow: bigint;
  /** Number of fills folded in so far. */
  fills: number;
}

export class PnlAccumulator {
  private position = 0n;
  private cashFlow = 0n;
  private fillCount = 0;

  /** Fold one fill into the running PnL. */
  onFill(side: Side, price: bigint, quantity: bigint): void {
    if (price < 0n || quantity < 0n) throw new Error("pnl: price/qty must be non-negative");
    const value = price * quantity;
    if (side === BUY) {
      this.position += quantity; // bought lots, paid cash
      this.cashFlow -= value;
    } else {
      this.position -= quantity; // sold lots, took cash
      this.cashFlow += value;
    }
    this.fillCount += 1;
  }

  /**
   * Total PnL marked at `mid` (µUSDC·lots units): `cashFlow + position·mid`.
   * Returns just the realized cash flow when `mid` is null (book one-sided), so
   * a one-sided book never invents an unrealized number off a missing mark.
   */
  pnl(mid: bigint | null): bigint {
    return mid === null ? this.cashFlow : this.cashFlow + this.position * mid;
  }

  snapshot(): PnlSnapshot {
    return { position: this.position, cashFlow: this.cashFlow, fills: this.fillCount };
  }
}
