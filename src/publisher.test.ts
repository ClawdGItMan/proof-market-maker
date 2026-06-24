import { describe, it, expect } from "vitest";
import { BotStatePublisher } from "./publisher.js";
import type { BotSnapshot, AuditRow, DashboardGateway, RemoteControl } from "./dashboardGateway.js";
import { pino } from "pino";

const log = pino({ level: "silent" });

const snap: BotSnapshot = {
  market: 1,
  ts: 1000,
  mode: "run",
  stale: false,
  staleSinceMs: 42,
  resyncs: 0,
  mid: 100n,
  bestBid: 99n,
  bestAsk: 101n,
  netPosition: 5n,
  pnl: 250n,
  openOrders: [{ id: 7n, side: 1, price: 99n, quantity: 10n }],
};

class RecordingGateway implements DashboardGateway {
  public states: BotSnapshot[] = [];
  public audits: AuditRow[][] = [];
  constructor(private readonly mode: "ok" | "throw") {}
  async publishSnapshot(s: BotSnapshot): Promise<void> {
    if (this.mode === "throw") throw new Error("boom");
    this.states.push(s);
  }
  async appendAudit(rows: AuditRow[]): Promise<void> {
    if (this.mode === "throw") throw new Error("boom");
    this.audits.push(rows);
  }
  async readControl(_: number): Promise<RemoteControl | null> {
    return null;
  }
}

describe("BotStatePublisher", () => {
  it("publishes state + open orders on a tick", async () => {
    const gw = new RecordingGateway("ok");
    await new BotStatePublisher(gw, log).publishTick(snap);
    expect(gw.states).toHaveLength(1);
    expect(gw.states[0]?.pnl).toBe(250n);
    expect(gw.states[0]?.openOrders).toHaveLength(1);
  });

  it("swallows a gateway error — a publish failure NEVER breaks a tick", async () => {
    const gw = new RecordingGateway("throw");
    // must resolve, not reject
    await expect(new BotStatePublisher(gw, log).publishTick(snap)).resolves.toBeUndefined();
  });

  it("audit append is best-effort and skips empty batches", async () => {
    const ok = new RecordingGateway("ok");
    const pub = new BotStatePublisher(ok, log);
    await pub.audit([]);
    expect(ok.audits).toHaveLength(0); // empty batch is a no-op (no network call)
    const rows: AuditRow[] = [{ ts: 1, kind: "fill", market: 1, id: "7" }];
    await pub.audit(rows);
    expect(ok.audits[0]).toEqual(rows);

    const bad = new BotStatePublisher(new RecordingGateway("throw"), log);
    await expect(bad.audit(rows)).resolves.toBeUndefined();
  });
});
