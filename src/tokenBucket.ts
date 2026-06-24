/**
 * Token-bucket rate limiter (ELO-10 reliability).
 *
 * The Proof gateway throttles bursty submitters; a market maker that requotes
 * aggressively can trip server-side rate limits and get its socket dropped —
 * which then cascades into a resync, more requotes, and a feedback loop. A
 * token bucket smooths submission to a sustainable rate while still allowing
 * short bursts up to `capacity`.
 *
 * The bucket is pure and clock-injectable: `tryRemove()` lazily refills based on
 * elapsed wall-clock, then consumes if enough tokens are available. Callers that
 * must wait can read `msUntil(n)` and sleep that long — no internal timers, so
 * the logic is fully unit-testable with a fake clock.
 */
export interface TokenBucketOpts {
  /** Maximum tokens the bucket can hold (burst size). */
  capacity: number;
  /** Sustained refill rate, tokens per second. */
  refillPerSec: number;
  /** Injectable ms clock. Defaults to Date.now. */
  now?: () => number;
  /** Starting token count. Defaults to full (`capacity`). */
  initial?: number;
}

export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(opts: TokenBucketOpts) {
    if (opts.capacity <= 0) throw new Error("token bucket capacity must be > 0");
    if (opts.refillPerSec <= 0) throw new Error("token bucket refillPerSec must be > 0");
    this.capacity = opts.capacity;
    this.refillPerMs = opts.refillPerSec / 1000;
    this.now = opts.now ?? Date.now;
    this.tokens = opts.initial ?? opts.capacity;
    this.last = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.last;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.last = t;
    }
  }

  /** Tokens currently available (after lazy refill). */
  get available(): number {
    this.refill();
    return this.tokens;
  }

  /** Consume `n` tokens if available; returns true on success, false if short. */
  tryRemove(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** Milliseconds until `n` tokens are available. Zero when already available. */
  msUntil(n = 1): number {
    this.refill();
    if (this.tokens >= n) return 0;
    return Math.ceil((n - this.tokens) / this.refillPerMs);
  }
}
