import { describe, it, expect } from "vitest";
import { Executor } from "./executor.js";
import type { ProofAdapter } from "./sdkAdapter.js";
import type { NonceManager } from "./nonceManager.js";
import { OrderTracker } from "./orderTracker.js";
import type { Logger } from "./logger.js";

/** No-op logger that satisfies the structured-logging surface the Executor uses. */
const nullLog = (): Logger => {
  const l: Record<string, unknown> = {};
  for (const m of ["info", "warn", "error", "debug"]) l[m] = () => {};
  l.child = () => nullLog();
  return l as unknown as Logger;
};

/** Nonce gate is a no-op for these tests — we only exercise cancel-all result handling. */
const okNonce = (): NonceManager => ({ gate: async () => {} } as unknown as NonceManager);

const buildExecutor = (cancelAllCode: number): Executor =>
  new Executor({
    adapter: {
      cancelAllOrdersCommit: async () => ({ code: cancelAllCode }),
    } as unknown as ProofAdapter,
    nonce: okNonce(),
    tracker: new OrderTracker(),
    log: nullLog(),
    market: 1,
  });

describe("Executor.killSwitch — cancel-all result must not be swallowed", () => {
  it("resolves when the exchange accepts the cancel-all (code 0)", async () => {
    await expect(buildExecutor(0).killSwitch()).resolves.toBeUndefined();
  });

  it("THROWS when the exchange rejects the cancel-all (non-zero code)", async () => {
    // Crash-recovery invariant: a rejected cancel-all (e.g. code 21 InvalidNonce
    // after a kill -9 left the on-disk nonce stale) must NOT look like success.
    // Otherwise reconcileOnStartup() quotes on top of un-cancelled orphan orders —
    // the exact failure the ELO-10 chaos criterion forbids.
    await expect(buildExecutor(21).killSwitch()).rejects.toThrow(/cancel-all/i);
  });
});
