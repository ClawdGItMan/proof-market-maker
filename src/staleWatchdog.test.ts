import { describe, it, expect } from "vitest";
import { StaleWatchdog } from "./staleWatchdog.js";

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("StaleWatchdog", () => {
  it("is not frozen before the first frame ever arrives", () => {
    const clk = fakeClock();
    const w = new StaleWatchdog({ thresholdMs: 1000, now: clk.now });
    expect(w.isFrozen()).toBe(false);
    expect(w.sinceLast).toBeNull();
  });

  it("flips to frozen only after the threshold of silence is exceeded", () => {
    const clk = fakeClock();
    const w = new StaleWatchdog({ thresholdMs: 1000, now: clk.now });
    w.feed();
    clk.advance(1000); // exactly threshold → still alive
    expect(w.isFrozen()).toBe(false);
    clk.advance(1); // past threshold
    expect(w.isFrozen()).toBe(true);
    expect(w.sinceLast).toBe(1001);
  });

  it("resets the timer each time a frame is fed", () => {
    const clk = fakeClock();
    const w = new StaleWatchdog({ thresholdMs: 500, now: clk.now });
    w.feed();
    clk.advance(400);
    w.feed(); // fresh frame resets
    clk.advance(400);
    expect(w.isFrozen()).toBe(false);
    clk.advance(200);
    expect(w.isFrozen()).toBe(true);
  });

  it("rejects a non-positive threshold", () => {
    expect(() => new StaleWatchdog({ thresholdMs: 0 })).toThrow();
  });
});
