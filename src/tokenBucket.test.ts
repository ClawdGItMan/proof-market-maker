import { describe, it, expect } from "vitest";
import { TokenBucket } from "./tokenBucket.js";

/** A controllable fake clock so refill behaviour is deterministic. */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("TokenBucket", () => {
  it("starts full and consumes down to empty", () => {
    const clk = fakeClock();
    const b = new TokenBucket({ capacity: 3, refillPerSec: 1, now: clk.now });
    expect(b.tryRemove()).toBe(true);
    expect(b.tryRemove()).toBe(true);
    expect(b.tryRemove()).toBe(true);
    expect(b.tryRemove()).toBe(false); // empty
  });

  it("refills at the configured rate over elapsed time", () => {
    const clk = fakeClock();
    const b = new TokenBucket({ capacity: 5, refillPerSec: 2, now: clk.now, initial: 0 });
    expect(b.tryRemove()).toBe(false);
    clk.advance(1000); // 2 tokens/sec → +2
    expect(b.available).toBeCloseTo(2, 5);
    expect(b.tryRemove(2)).toBe(true);
    expect(b.tryRemove()).toBe(false);
  });

  it("never refills beyond capacity (no burst banking)", () => {
    const clk = fakeClock();
    const b = new TokenBucket({ capacity: 4, refillPerSec: 10, now: clk.now, initial: 0 });
    clk.advance(100_000); // would be 1000 tokens uncapped
    expect(b.available).toBe(4);
  });

  it("reports ms until the next token is available", () => {
    const clk = fakeClock();
    const b = new TokenBucket({ capacity: 2, refillPerSec: 4, now: clk.now, initial: 0 });
    // 4 tokens/sec → 250ms per token
    expect(b.msUntil(1)).toBe(250);
    expect(b.msUntil(2)).toBe(500);
    clk.advance(250);
    expect(b.msUntil(1)).toBe(0);
  });

  it("rejects nonsensical configuration", () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSec: 1 })).toThrow();
    expect(() => new TokenBucket({ capacity: 1, refillPerSec: 0 })).toThrow();
  });
});
