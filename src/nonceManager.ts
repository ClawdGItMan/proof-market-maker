/**
 * Persistent, monotonic nonce manager.
 *
 * Background (ELO-8 spike): the Proof engine uses **timestamp nonces** — each
 * signed tx carries a wall-clock-ms `seq`, validated against a sliding window;
 * a burned nonce is never reissued (engine code 21 = InvalidNonce on replay).
 * The vendored SDK allocates these internally with `max(now_ms, last+1)` capped
 * at `now+60s`, but its counter lives only in memory and resets to 0 on every
 * process restart. There is no public hook to inject a nonce into
 * `submitTxCommit`.
 *
 * The single cross-restart hazard: a fast burst pushes the SDK's nonce into the
 * future (toward the +60s cap), the process restarts within that window, and
 * the fresh SDK (counter = 0) signs with `max(now, 1) = now` — which can be
 * *behind* an already-burned future nonce → code 21, a stuck bot.
 *
 * This manager closes that gap two ways:
 *   1. `allocate()` — the authoritative allocator: same algorithm as the SDK
 *      but with the high-water mark **persisted to disk after every call**, so
 *      monotonicity survives restarts and clock rewinds. (Used when we own the
 *      signing path; also the unit-tested core.)
 *   2. `gate()` — the safety valve for the SDK-owned path we actually run: it
 *      blocks until wall-clock has strictly passed the persisted high-water
 *      mark, *then* lets the SDK allocate. Because the SDK computes
 *      `max(now, …)` and `now` is now guaranteed `> hwm`, the SDK can never
 *      regress below a burned nonce. It then records the new `now` as the hwm.
 *
 * The on-disk store is a single decimal integer, written atomically
 * (temp-file + rename) so a crash mid-write cannot corrupt it.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface NonceStore {
  /** Return the persisted high-water mark, or null if none yet. */
  read(): bigint | null;
  /** Durably persist the high-water mark. Must be atomic. */
  write(hwm: bigint): void;
}

/** Atomic, single-integer file store (default for production). */
export class FileNonceStore implements NonceStore {
  constructor(private readonly path: string) {}

  read(): bigint | null {
    try {
      const raw = readFileSync(this.path, "utf8").trim();
      return /^\d+$/.test(raw) ? BigInt(raw) : null;
    } catch {
      return null; // missing file → no prior state
    }
  }

  write(hwm: bigint): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, hwm.toString(), "utf8");
    renameSync(tmp, this.path); // atomic on the same filesystem
  }
}

export interface NonceManagerOpts {
  store: NonceStore;
  /** Injectable clock (ms since epoch). Defaults to Date.now. */
  now?: () => bigint;
  /** Cap on how far ahead of wall-clock a nonce may run. Defaults to 60s. */
  futureCapMs?: bigint;
}

type SleepFn = (ms: number) => Promise<void>;
const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export class NonceManager {
  private hwm: bigint;
  private readonly store: NonceStore;
  private readonly now: () => bigint;
  private readonly cap: bigint;

  constructor(opts: NonceManagerOpts) {
    this.store = opts.store;
    this.now = opts.now ?? (() => BigInt(Date.now()));
    this.cap = opts.futureCapMs ?? 60_000n;
    this.hwm = this.store.read() ?? 0n;
  }

  /** Current persisted high-water mark. */
  get highWaterMark(): bigint {
    return this.hwm;
  }

  /**
   * Allocate the next nonce: `max(now, hwm+1)`, capped at `now + futureCapMs`,
   * persisting the new high-water mark. Strictly monotonic across calls,
   * restarts, and clock rewinds.
   */
  allocate(): bigint {
    const now = this.now();
    const cap = now + this.cap;
    let next = this.hwm >= now ? this.hwm + 1n : now;
    if (next > cap) next = cap;
    this.hwm = next;
    this.store.write(this.hwm);
    return next;
  }

  /**
   * Milliseconds to wait so wall-clock strictly exceeds the high-water mark.
   * Zero when already safe.
   */
  waitMsUntilSafe(): bigint {
    const now = this.now();
    return now > this.hwm ? 0n : this.hwm - now + 1n;
  }

  /**
   * Block until wall-clock has passed the high-water mark, then record the
   * current time as the new mark. Call this immediately before letting the SDK
   * sign+submit, so the SDK's internal `max(now, …)` can never pick a nonce at
   * or below an already-burned one — even across a restart.
   */
  async gate(sleep: SleepFn = defaultSleep): Promise<void> {
    const wait = this.waitMsUntilSafe();
    if (wait > 0n) await sleep(Number(wait));
    const now = this.now();
    if (now > this.hwm) {
      this.hwm = now;
      this.store.write(this.hwm);
    }
  }
}
