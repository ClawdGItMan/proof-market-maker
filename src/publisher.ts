/**
 * Bot-state publisher (ELO-13): mirror live bot state + audit events to Supabase
 * for the read-only dashboard, alongside the existing pino logs and crash journal.
 *
 * Hard contract: **publishing is best-effort and must NEVER break a tick.** A
 * dashboard outage, a slow network, or a Supabase error must not stop quoting or
 * delay reconciliation — the dashboard is an observer, not part of the trading
 * critical path. Every method swallows errors (logs at warn) and returns.
 *
 * Optional dependency, exactly like `killControl?` / `watchdog?` / `journal?` on
 * the MarketMaker: when no gateway is configured the publisher is a no-op, so
 * paper-trading and the unit tests run with no Supabase at all.
 */
import type { BotSnapshot, AuditRow, DashboardGateway } from "./dashboardGateway.js";
import type { Logger } from "./logger.js";

export class BotStatePublisher {
  constructor(
    private readonly gateway: DashboardGateway,
    private readonly log: Logger,
  ) {}

  /** Publish the latest state snapshot + open-orders for this tick. Best-effort. */
  async publishTick(snap: BotSnapshot): Promise<void> {
    try {
      await this.gateway.publishSnapshot(snap);
    } catch (e) {
      this.log.warn({ err: String(e) }, "publisher: state publish failed (non-fatal)");
    }
  }

  /** Mirror audit-relevant events (order intents, kill-switch transitions). Best-effort. */
  async audit(rows: AuditRow[]): Promise<void> {
    if (rows.length === 0) return;
    try {
      await this.gateway.appendAudit(rows);
    } catch (e) {
      this.log.warn({ err: String(e) }, "publisher: audit append failed (non-fatal)");
    }
  }
}
