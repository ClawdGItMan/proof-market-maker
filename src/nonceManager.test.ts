import { describe, it, expect } from "vitest";
import { NonceManager, type NonceStore } from "./nonceManager.js";

/** In-memory store standing in for the on-disk file, so tests are hermetic. */
class MemStore implements NonceStore {
  value: bigint | null = null;
  reads = 0;
  writes = 0;
  read(): bigint | null {
    this.reads += 1;
    return this.value;
  }
  write(hwm: bigint): void {
    this.writes += 1;
    this.value = hwm;
  }
}

/** A controllable clock so we can test monotonicity independent of real time. */
function fakeClock(start: bigint) {
  let t = start;
  return {
    now: () => t,
    set: (v: bigint) => (t = v),
    advance: (d: bigint) => (t += d),
  };
}

describe("NonceManager.allocate", () => {
  it("returns the wall clock when ahead of the high-water mark", () => {
    const store = new MemStore();
    const clk = fakeClock(1_000n);
    const nm = new NonceManager({ store, now: clk.now });
    expect(nm.allocate()).toBe(1_000n);
  });

  it("is strictly monotonic even when the clock is frozen (burst within a ms)", () => {
    const store = new MemStore();
    const clk = fakeClock(1_000n);
    const nm = new NonceManager({ store, now: clk.now });
    const a = nm.allocate();
    const b = nm.allocate();
    const c = nm.allocate();
    expect([a, b, c]).toEqual([1_000n, 1_001n, 1_002n]);
  });

  it("never regresses when the clock rewinds (NTP step back)", () => {
    const store = new MemStore();
    const clk = fakeClock(5_000n);
    const nm = new NonceManager({ store, now: clk.now });
    const a = nm.allocate(); // 5000
    clk.set(4_000n); // clock jumps backwards
    const b = nm.allocate(); // must still be > a
    expect(a).toBe(5_000n);
    expect(b).toBe(5_001n);
    expect(b > a).toBe(true);
  });

  it("caps a runaway burst at now + futureCapMs", () => {
    const store = new MemStore();
    const clk = fakeClock(1_000n);
    const nm = new NonceManager({ store, now: clk.now, futureCapMs: 5n });
    const out = Array.from({ length: 10 }, () => nm.allocate());
    // 1000,1001,...1005 then pinned at the cap (now+5 = 1005)
    expect(out[5]).toBe(1_005n);
    expect(out[9]).toBe(1_005n);
  });

  it("persists the high-water mark on every allocation", () => {
    const store = new MemStore();
    const clk = fakeClock(1_000n);
    const nm = new NonceManager({ store, now: clk.now });
    nm.allocate();
    nm.allocate();
    expect(store.writes).toBe(2);
    expect(store.value).toBe(1_001n);
  });
});

describe("NonceManager persistence across restart", () => {
  it("a fresh manager seeded from the store never re-issues a burned nonce", () => {
    const store = new MemStore();
    const clk = fakeClock(2_000n);
    // First process bursts 3 nonces into the (frozen-clock) future.
    const nm1 = new NonceManager({ store, now: clk.now });
    nm1.allocate(); // 2000
    nm1.allocate(); // 2001
    const last = nm1.allocate(); // 2002
    expect(last).toBe(2_002n);

    // "Restart": brand-new manager, SAME store, wall clock has NOT advanced
    // past the burned future nonces.
    const nm2 = new NonceManager({ store, now: clk.now });
    const next = nm2.allocate();
    expect(next).toBe(2_003n); // strictly greater than the last burned one
    expect(next > last).toBe(true);
  });
});

describe("NonceManager.gate (SDK-safety gate)", () => {
  it("reports zero wait when the clock already leads the high-water mark", () => {
    const store = new MemStore();
    const clk = fakeClock(1_000n);
    const nm = new NonceManager({ store, now: clk.now });
    nm.allocate(); // hwm = 1000
    clk.set(1_001n);
    expect(nm.waitMsUntilSafe()).toBe(0n);
  });

  it("reports the exact wait needed when the high-water mark is in the future", () => {
    const store = new MemStore();
    const clk = fakeClock(1_000n);
    const nm = new NonceManager({ store, now: clk.now, futureCapMs: 1_000n });
    nm.allocate(); // 1000
    nm.allocate(); // 1001 (future-dated by 1ms vs frozen clock)
    // clock at 1000, hwm at 1001 → need to wait until 1002 (>1001)
    expect(nm.waitMsUntilSafe()).toBe(2n);
  });

  it("gate() sleeps until the clock passes the high-water mark, then advances it", async () => {
    const store = new MemStore();
    const clk = fakeClock(1_000n);
    const nm = new NonceManager({ store, now: clk.now, futureCapMs: 1_000n });
    nm.allocate();
    nm.allocate(); // hwm = 1001, clock still 1000
    let slept = 0n;
    await nm.gate((ms) => {
      slept = BigInt(ms);
      clk.advance(BigInt(ms)); // simulate time passing during the sleep
      return Promise.resolve();
    });
    expect(slept).toBe(2n); // waited 2ms → clock now 1002 > 1001
    expect(nm.highWaterMark).toBe(1_002n); // hwm advanced to current clock
  });
});
