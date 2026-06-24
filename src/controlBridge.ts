/**
 * Control bridge (ELO-13): mirror the dashboard's desired kill-switch mode into
 * the bot's local control file, so a button click on Vercel reaches a bot whose
 * `data/control` file lives on a different host.
 *
 * The trading loop still reads the LOCAL file as its single source of truth
 * (see bot.ts `tick()`), so two safety invariants hold no matter what the cloud
 * says:
 *
 *   1. Cloud down → the bridge no-ops, the file is untouched, the bot keeps
 *      honoring the last-synced mode + the manual `echo hard > data/control`
 *      break-glass. The cloud can never *prevent* a stop.
 *   2. A panic `hard` written to disk before a crash/reboot is NOT auto-cleared
 *      by a *stale* cloud value the bridge has never seen issued. Only a *fresh*
 *      dashboard command (newer `updatedAt` than we've applied) changes the mode.
 *
 * `resolveControl` is pure and exhaustively unit-tested; the poller is the thin
 * I/O shell that reads the remote row and writes the file via KillControl.
 */
import type { KillMode } from "./killControl.js";
import { KillControl } from "./killControl.js";
import type { DashboardGateway, RemoteControl } from "./dashboardGateway.js";
import type { Logger } from "./logger.js";

export interface ResolveInput {
  /** Current mode on the local control file. */
  local: KillMode;
  /** Desired mode from the dashboard, or null if no row / unreachable. */
  remote: RemoteControl | null;
  /** updatedAt of the last remote command the bridge has applied (0 = none yet). */
  lastAppliedAt: number;
}

export interface ResolveResult {
  /** Mode to write to the local file, or null to leave the file untouched. */
  apply: KillMode | null;
  /** New high-water mark for applied remote commands. */
  lastAppliedAt: number;
}

/**
 * Decide whether a remote control command should be mirrored to the local file.
 *
 * Rules, in order:
 *  - no remote row / unreachable → leave the file alone.
 *  - remote not newer than what we already applied → already handled, no-op.
 *  - remote mode already equals local → nothing to write, but advance the marker.
 *  - COLD START (lastAppliedAt === 0) with a local `hard` and a NON-hard remote →
 *    refuse: a brand-new bridge must not clear a panic-hard on disk using a
 *    remote value it never watched get issued. Adopt the remote timestamp so a
 *    genuinely newer command later still wins.
 *  - otherwise → mirror the remote mode to the file.
 */
export function resolveControl(input: ResolveInput): ResolveResult {
  const { local, remote, lastAppliedAt } = input;
  if (remote === null) return { apply: null, lastAppliedAt };
  if (remote.updatedAt <= lastAppliedAt) return { apply: null, lastAppliedAt };
  if (remote.mode === local) return { apply: null, lastAppliedAt: remote.updatedAt };
  if (lastAppliedAt === 0 && local === "hard" && remote.mode !== "hard") {
    return { apply: null, lastAppliedAt: remote.updatedAt }; // sticky panic-hard
  }
  return { apply: remote.mode, lastAppliedAt: remote.updatedAt };
}

/**
 * Stateful poller: each call reads the remote control row, resolves it against
 * the local file, and writes the file if a fresh command warrants it. Best-effort
 * — a gateway error is logged and swallowed so a control read can never break a
 * tick (the local file remains authoritative).
 */
export class ControlBridge {
  private lastAppliedAt = 0;

  constructor(
    private readonly gateway: DashboardGateway,
    private readonly kill: KillControl,
    private readonly market: number,
    private readonly log: Logger,
  ) {}

  async poll(): Promise<void> {
    let remote: RemoteControl | null;
    try {
      remote = await this.gateway.readControl(this.market);
    } catch (e) {
      this.log.warn({ err: String(e) }, "control bridge: remote read failed — keeping local control");
      return;
    }
    const local = this.kill.read();
    const { apply, lastAppliedAt } = resolveControl({ local, remote, lastAppliedAt: this.lastAppliedAt });
    this.lastAppliedAt = lastAppliedAt;
    if (apply !== null) {
      this.kill.set(apply);
      this.log.warn({ mode: apply, by: remote?.updatedBy ?? "dashboard" }, "control bridge: applied dashboard mode to local control file");
    }
  }
}
