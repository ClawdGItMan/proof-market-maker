import { describe, expect, it } from "vitest";
import { ago, lots, microUsdc, price, toBig } from "./format";

describe("toBig", () => {
  it("parses big decimal strings without Number rounding", () => {
    // 184467440737095 exceeds 2^53? no, but u64 ids can — verify exactness past 2^53.
    expect(toBig("9007199254740993")).toBe(9007199254740993n); // 2^53 + 1, unsafe as Number
  });
  it("returns null for null/empty/garbage", () => {
    expect(toBig(null)).toBeNull();
    expect(toBig("")).toBeNull();
    expect(toBig("12x")).toBeNull();
  });
});

describe("microUsdc", () => {
  it("scales µUSDC to USDC with 6 decimals and grouping", () => {
    expect(microUsdc("1005000")).toBe("$1.005000");
    expect(microUsdc("1234567890")).toBe("$1,234.567890");
  });
  it("formats negatives with the sign outside the $", () => {
    expect(microUsdc("-148500")).toBe("-$0.148500");
  });
  it("renders null as em dash", () => {
    expect(microUsdc(null)).toBe("—");
  });
});

describe("lots", () => {
  it("shows an explicit sign and never a decimal", () => {
    expect(lots("5")).toBe("+5");
    expect(lots("-3")).toBe("-3");
    expect(lots("0")).toBe("0");
  });
});

describe("price", () => {
  it("groups integer µUSDC prices", () => {
    expect(price("1004500")).toBe("1,004,500");
    expect(price(null)).toBe("—");
  });
});

describe("ago", () => {
  it("buckets elapsed time into human units", () => {
    const now = 1_000_000;
    expect(ago(now, now)).toBe("just now");
    expect(ago(now - 3_000, now)).toBe("3s ago");
    expect(ago(now - 120_000, now)).toBe("2m ago");
    expect(ago(now - 7_200_000, now)).toBe("2h ago");
    expect(ago(null, now)).toBe("never");
  });
});
