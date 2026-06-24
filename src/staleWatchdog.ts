/**
 * Staleness watchdog (ELO-10 reliability).
 *
 * The resync path in `bot.ts` already reacts to an *explicit* socket close. But
 * a socket can stay open while the feed silently stops — the gateway wedges, a
 * proxy half-opens the connection, or updates simply stop arriving. A maker
 * quoting off a frozen book is exactly how you get picked off. This watchdog
 * catches the silent case: every inbound book frame calls `feed()`, and each
 * tick the bot asks `isFrozen()`. If nothing has arrived within `thresholdMs`,
 * the bot treats the book as stale and pulls all quotes, just like a real drop.
 *
 * Pure and clock-injectable — no internal timers — so the freeze boundary is
 * unit-tested with a fake clock.
 */
export interface StaleWatchdogOpts {
  /** Max silence before the book is considered frozen, in ms. */
  thresholdMs: number;
  /** Injectable ms clock. Defaults to Date.now. */
  now?: () => number;
}

export class StaleWatchdog {
  private lastSeen: number | null = null;
  private readonly thresholdMs: number;
  private readonly now: () => number;

  constructor(opts: StaleWatchdogOpts) {
    if (opts.thresholdMs <= 0) throw new Error("watchdog thresholdMs must be > 0");
    this.thresholdMs = opts.thresholdMs;
    this.now = opts.now ?? Date.now;
  }

  /** Record that a fresh book frame just arrived. */
  feed(): void {
    this.lastSeen = this.now();
  }

  /** Ms since the last frame, or null if nothing has ever arrived. */
  get sinceLast(): number | null {
    return this.lastSeen === null ? null : this.now() - this.lastSeen;
  }

  /**
   * True when the feed has gone silent past the threshold. Before the first
   * frame ever arrives we report `false` — connect()'s own snapshot timeout
   * owns the cold-start case, not the watchdog.
   */
  isFrozen(): boolean {
    if (this.lastSeen === null) return false;
    return this.now() - this.lastSeen > this.thresholdMs;
  }
}
