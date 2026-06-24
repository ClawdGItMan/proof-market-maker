/**
 * Executor: turn the diff's actions into committed exchange transactions.
 *
 * Responsibilities kept here (and *only* here):
 *  - **Nonce safety.** Before every submit we `gate()` the nonce manager so the
 *    SDK's internal timestamp allocator can never pick a nonce ≤ a burned one,
 *    even right after a restart (see nonceManager.ts).
 *  - **Lifecycle bookkeeping.** Feed placements/cancels into the OrderTracker.
 *  - **Structured logging** of every action and rejection.
 *  - **Kill-switch**: cancel-all in a single tx.
 *
 * Quotes are post-only by default: a maker that accidentally crosses pays taker
 * fees and risks adverse fills, so we'd rather the engine reject (code 34) than
 * cross.
 */
import { ProofAdapter, Side, TimeInForce } from "./sdkAdapter.js";
import type { NonceManager } from "./nonceManager.js";
import type { OrderTracker } from "./orderTracker.js";
import type { DiffAction } from "./diff.js";
import type { Logger } from "./logger.js";
import type { TokenBucket } from "./tokenBucket.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ExecutorOpts {
  adapter: ProofAdapter;
  nonce: NonceManager;
  tracker: OrderTracker;
  log: Logger;
  market: number;
  /** Post-only quotes (default true). */
  postOnly?: boolean;
  /** Optional rate-limit throttle: blocks before each submit until a token is free. */
  bucket?: TokenBucket;
}

/** diff's numeric Side (1|2) is the SDK enum's encoding; cast at this boundary. */
const toSdkSide = (s: 1 | 2): Side => s as unknown as Side;

export class Executor {
  private readonly postOnly: boolean;
  constructor(private readonly o: ExecutorOpts) {
    this.postOnly = o.postOnly ?? true;
  }

  /** Block until the rate-limit bucket grants a token (no-op when unconfigured). */
  private async throttle(): Promise<void> {
    const b = this.o.bucket;
    if (!b) return;
    let waited = 0;
    while (!b.tryRemove()) {
      const ms = b.msUntil();
      waited += ms;
      await sleep(ms);
    }
    if (waited > 0) this.o.log.debug({ waitedMs: waited }, "rate-limit throttle");
  }

  /** Apply diff actions in order. Each is a synchronous commit (~750ms). */
  async apply(actions: DiffAction[]): Promise<void> {
    for (const a of actions) {
      try {
        await this.throttle();
        await this.o.nonce.gate();
        if (a.kind === "place") {
          const r = await this.o.adapter.placeOrderCommit({
            market: this.o.market,
            side: toSdkSide(a.side),
            price: a.price,
            quantity: a.quantity,
            postOnly: this.postOnly,
            timeInForce: TimeInForce.Gtc,
          });
          if (r.tx.code === 0) {
            if (r.orderId != null) {
              this.o.tracker.onResting({ id: r.orderId, side: a.side, price: a.price, quantity: a.quantity });
            }
            this.o.log.info({ act: "place", side: a.side, price: a.price, qty: a.quantity, orderId: r.orderId }, "placed");
          } else {
            this.o.log.warn({ act: "place", code: r.tx.code, reason: r.tx.log }, "place rejected");
          }
        } else if (a.kind === "cancel") {
          const r = await this.o.adapter.cancelOrderCommit(a.id);
          if (r.code === 0) this.o.tracker.onCancelled(a.id);
          this.o.log.info({ act: "cancel", id: a.id, code: r.code }, "cancel");
        } else {
          // cancelReplace
          const r = await this.o.adapter.cancelReplaceCommit({
            cancelOrderId: a.id,
            market: this.o.market,
            side: toSdkSide(a.side),
            price: a.price,
            quantity: a.quantity,
            postOnly: this.postOnly,
            timeInForce: TimeInForce.Gtc,
          });
          if (r.tx.code === 0) {
            this.o.tracker.onCancelled(a.id);
            if (r.orderId != null) {
              this.o.tracker.onResting({ id: r.orderId, side: a.side, price: a.price, quantity: a.quantity });
            }
            this.o.log.info({ act: "cancelReplace", oldId: a.id, newId: r.orderId, price: a.price, qty: a.quantity }, "replaced");
          } else {
            this.o.log.warn({ act: "cancelReplace", id: a.id, code: r.tx.code, reason: r.tx.log }, "replace rejected");
          }
        }
      } catch (e) {
        this.o.log.error({ act: a.kind, err: String(e) }, "execution error");
      }
    }
  }

  /**
   * Kill-switch: cancel every resting order for our wallet on this market.
   *
   * Throws if the engine rejects the cancel-all (non-zero code). A rejected
   * cancel-all must NEVER be mistaken for success: `reconcileOnStartup()` relies
   * on this to refuse to quote on top of un-cancelled orphans after a crash
   * (e.g. code 21 InvalidNonce when a kill -9 left the on-disk nonce stale), and
   * the in-tick stale-pull relies on it to retry on the next tick rather than
   * quote off a book it failed to flatten. Callers that want best-effort
   * (shutdown flatten) wrap this in try/catch.
   */
  async killSwitch(): Promise<void> {
    await this.o.nonce.gate();
    const r = await this.o.adapter.cancelAllOrdersCommit(this.o.market);
    this.o.log.warn({ act: "cancelAll", market: this.o.market, code: r.code }, "KILL-SWITCH fired");
    if (r.code !== 0) {
      throw new Error(`cancel-all rejected (code ${r.code}) — orders may still be resting`);
    }
  }
}
