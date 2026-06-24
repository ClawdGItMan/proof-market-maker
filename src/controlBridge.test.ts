import { describe, it, expect, afterEach } from "vitest";
import { rmSync, readFileSync } from "node:fs";
import { resolveControl, ControlBridge } from "./controlBridge.js";
import { KillControl } from "./killControl.js";
import type { DashboardGateway, RemoteControl, BotSnapshot, AuditRow } from "./dashboardGateway.js";
import { pino } from "pino";

const log = pino({ level: "silent" });

describe("resolveControl", () => {
  it("no remote row → leave the local file untouched", () => {
    expect(resolveControl({ local: "run", remote: null, lastAppliedAt: 5 })).toEqual({ apply: null, lastAppliedAt: 5 });
  });

  it("stale remote (not newer than applied) → no-op", () => {
    const remote: RemoteControl = { mode: "hard", updatedAt: 5 };
    expect(resolveControl({ local: "run", remote, lastAppliedAt: 5 })).toEqual({ apply: null, lastAppliedAt: 5 });
    expect(resolveControl({ local: "run", remote, lastAppliedAt: 9 })).toEqual({ apply: null, lastAppliedAt: 9 });
  });

  it("fresh remote command is mirrored and advances the marker", () => {
    const remote: RemoteControl = { mode: "soft", updatedAt: 10 };
    expect(resolveControl({ local: "run", remote, lastAppliedAt: 5 })).toEqual({ apply: "soft", lastAppliedAt: 10 });
  });

  it("remote equals local → advances marker without a redundant write", () => {
    const remote: RemoteControl = { mode: "soft", updatedAt: 10 };
    expect(resolveControl({ local: "soft", remote, lastAppliedAt: 0 })).toEqual({ apply: null, lastAppliedAt: 10 });
  });

  it("COLD START refuses to clear a panic-hard on disk with a stale non-hard remote", () => {
    // operator did `echo hard` before a reboot; remote table still says run.
    const remote: RemoteControl = { mode: "run", updatedAt: 100 };
    const r = resolveControl({ local: "hard", remote, lastAppliedAt: 0 });
    expect(r.apply).toBeNull(); // hard stays
    expect(r.lastAppliedAt).toBe(100); // but adopt ts so a genuinely newer cmd later wins
  });

  it("a fresh dashboard 'run' after cold start CAN clear a hard (deliberate operator action)", () => {
    // after the cold-start adopt above (marker now 100), a newer click wins.
    const remote: RemoteControl = { mode: "run", updatedAt: 200 };
    expect(resolveControl({ local: "hard", remote, lastAppliedAt: 100 })).toEqual({ apply: "run", lastAppliedAt: 200 });
  });

  it("a fresh dashboard HARD always applies, even at cold start", () => {
    const remote: RemoteControl = { mode: "hard", updatedAt: 100 };
    expect(resolveControl({ local: "run", remote, lastAppliedAt: 0 })).toEqual({ apply: "hard", lastAppliedAt: 100 });
  });
});

class FakeGateway implements DashboardGateway {
  constructor(private control: RemoteControl | null, public throwOnRead = false) {}
  async publishSnapshot(_: BotSnapshot): Promise<void> {}
  async appendAudit(_: AuditRow[]): Promise<void> {}
  async readControl(_: number): Promise<RemoteControl | null> {
    if (this.throwOnRead) throw new Error("network down");
    return this.control;
  }
  setControl(c: RemoteControl): void {
    this.control = c;
  }
}

describe("ControlBridge poller", () => {
  const path = ".tmp/test-bridge-control";
  afterEach(() => rmSync(path, { force: true }));

  it("mirrors a fresh dashboard command to the local file", async () => {
    const kill = new KillControl(path);
    kill.set("run");
    const gw = new FakeGateway({ mode: "hard", updatedAt: 1000 });
    const bridge = new ControlBridge(gw, kill, 1, log);
    await bridge.poll();
    expect(kill.read()).toBe("hard");
  });

  it("does not re-apply the same command twice (idempotent on the marker)", async () => {
    const kill = new KillControl(path);
    kill.set("run");
    const gw = new FakeGateway({ mode: "soft", updatedAt: 1000 });
    const bridge = new ControlBridge(gw, kill, 1, log);
    await bridge.poll();
    expect(kill.read()).toBe("soft");
    // an operator manually overrides to hard; a stale (same-ts) remote must NOT undo it
    kill.set("hard");
    await bridge.poll();
    expect(kill.read()).toBe("hard");
  });

  it("a gateway read failure leaves the local file untouched (cloud can never prevent a stop)", async () => {
    const kill = new KillControl(path);
    kill.set("hard");
    const gw = new FakeGateway(null, true);
    const bridge = new ControlBridge(gw, kill, 1, log);
    await bridge.poll(); // must not throw
    expect(kill.read()).toBe("hard");
  });
});
