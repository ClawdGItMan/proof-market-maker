import { describe, it, expect } from "vitest";
import { PnlAccumulator } from "./pnl.js";
import type { Side } from "./diff.js";

const BUY: Side = 1;
const SELL: Side = 2;

describe("PnlAccumulator", () => {
  it("starts flat with zero pnl", () => {
    const p = new PnlAccumulator();
    expect(p.snapshot()).toEqual({ position: 0n, cashFlow: 0n, fills: 0 });
    expect(p.pnl(100n)).toBe(0n);
  });

  it("a flat round-trip realizes the spread regardless of mark", () => {
    const p = new PnlAccumulator();
    p.onFill(BUY, 100n, 10n); // pay 1000
    p.onFill(SELL, 110n, 10n); // receive 1100
    expect(p.snapshot().position).toBe(0n);
    // flat → pnl is pure realized cash and ignores the mark entirely
    expect(p.pnl(100n)).toBe(100n);
    expect(p.pnl(999n)).toBe(100n);
    expect(p.pnl(null)).toBe(100n);
  });

  it("marks an open long to market", () => {
    const p = new PnlAccumulator();
    p.onFill(BUY, 100n, 10n); // long 10 @ 100, cash -1000
    expect(p.pnl(100n)).toBe(0n); // marked at cost → flat pnl
    expect(p.pnl(105n)).toBe(50n); // +5 per lot × 10 = +50 unrealized
    expect(p.pnl(95n)).toBe(-50n); // mark below cost → loss
  });

  it("marks an open short to market (gains when price falls)", () => {
    const p = new PnlAccumulator();
    p.onFill(SELL, 100n, 10n); // short 10 @ 100, cash +1000
    expect(p.snapshot().position).toBe(-10n);
    expect(p.pnl(100n)).toBe(0n);
    expect(p.pnl(90n)).toBe(100n); // price fell 10 × 10 short = +100
    expect(p.pnl(110n)).toBe(-100n);
  });

  it("a one-sided book (null mark) reports realized cash only, never invents a mark", () => {
    const p = new PnlAccumulator();
    p.onFill(BUY, 100n, 5n); // open long, -500 cash
    expect(p.pnl(null)).toBe(-500n); // realized cash flow only
    expect(p.snapshot().fills).toBe(1);
  });

  it("rejects negative price/qty", () => {
    const p = new PnlAccumulator();
    expect(() => p.onFill(BUY, -1n, 1n)).toThrow();
    expect(() => p.onFill(SELL, 1n, -1n)).toThrow();
  });
});
