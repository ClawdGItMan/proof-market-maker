/**
 * SDK adapter — the ONE file in this project allowed to import the Proof
 * trading SDK. Everything else depends on this stable surface, so a future
 * SDK swap/upgrade has a one-file blast radius (ELO-8 requirement).
 *
 * SDK is pinned via git submodule at vendor/trading-sdk @ commit
 * 634f84b7b9cb73de1c8957df75d9971dd16f6876 and imported from source (the SDK
 * is designed to run from source under tsx; see its examples/).
 *
 * Unit conventions (from SDK README):
 *   - price:    cents (2dp).  6675234 = $66,752.34
 *   - quantity: integer contracts (lots)
 *   - balances: microUSDC (6dp)
 * All prices/quantities are u64 → represented as BigInt end-to-end.
 */
import {
  ExchangeClient,
  Side,
  TimeInForce,
  hexToBytes,
  ownerToHex,
  type Address,
  type Orderbook,
  type OpenOrder,
  type MarketConfig,
  type TxResult,
  type TxEvent,
} from "../vendor/trading-sdk/dist/index.js";
import type { Config } from "./config.js";
import { streamOrderbook, type OrderbookStreamHandlers } from "./orderbookStream.js";

export { Side, TimeInForce };
export type { Orderbook, OpenOrder, MarketConfig, TxResult };

export interface PlaceParams {
  market: number;
  side: Side;
  price: bigint;
  quantity: bigint;
  postOnly?: boolean;
  timeInForce?: TimeInForce;
}

export interface PlaceResult {
  tx: TxResult;
  /** Engine-assigned order id, extracted from the OrderPlaced event when present. */
  orderId: bigint | null;
}

export class ProofAdapter {
  private readonly client: ExchangeClient;
  private readonly owner: Address;
  private readonly gatewayUrl: string;
  readonly addressHex: string;

  constructor(cfg: Config) {
    this.gatewayUrl = cfg.gatewayUrl;
    this.client = new ExchangeClient({
      gatewayUrl: cfg.gatewayUrl,
      chainId: cfg.chainId,
    });
    this.client.setPrivateKey(hexToBytes(cfg.privateKeyHex));
    const owner = this.client.getAddress();
    if (!owner) throw new Error("adapter: private key did not yield an address");
    this.owner = owner;
    this.addressHex = `0x${ownerToHex(owner)}`;
    // Sanity: the key must control the wallet the env claims.
    if (this.addressHex.toLowerCase() !== cfg.addressHex.toLowerCase()) {
      throw new Error(
        `adapter: derived address ${this.addressHex} != PROOF_ADDRESS ${cfg.addressHex} — wrong key/env`,
      );
    }
  }

  // --- Reads ------------------------------------------------------------
  health() {
    return this.client.queryHealth();
  }
  markets(): Promise<MarketConfig[]> {
    return this.client.queryMarkets();
  }
  orderbook(market: number): Promise<Orderbook> {
    return this.client.queryOrderbook(market);
  }
  openOrders(): Promise<OpenOrder[]> {
    return this.client.queryOpenOrders(this.addressHex);
  }
  account() {
    return this.client.queryAccount(this.addressHex);
  }
  /** Timestamp nonces the node has retained for our account (lifecycle evidence). */
  recentNonces(): Promise<bigint[]> {
    return this.client.getRecentNonces(this.addressHex);
  }

  // --- Streaming -------------------------------------------------------
  /**
   * Subscribe to the live orderbook feed. NOTE: the bundled SDK's
   * `subscribeOrderbookDeltas` does not work against this devnet (wrong path +
   * protocol), so we talk to `<gateway>/ws` directly via streamOrderbook.
   * Frames are Zod-validated before reaching the handlers.
   */
  streamOrderbook(market: number, handlers: OrderbookStreamHandlers): () => void {
    return streamOrderbook(this.gatewayUrl, market, handlers);
  }

  // --- Order path (BigInt end-to-end) -----------------------------------
  /**
   * Place a limit order and wait for the DeliverTx (commit) result.
   * Returns the TxResult plus the engine order id parsed from events.
   */
  async placeOrderCommit(p: PlaceParams): Promise<PlaceResult> {
    const tx = await this.client.submitTxCommit({
      type: "PlaceOrder",
      data: {
        market: p.market,
        owner: this.owner,
        side: p.side,
        price: p.price,
        quantity: p.quantity,
        postOnly: p.postOnly,
        timeInForce: p.timeInForce,
      },
    });
    return { tx, orderId: extractOrderId(tx.events) };
  }

  /** Cancel a resting order by engine id, waiting for the commit result. */
  cancelOrderCommit(orderId: bigint): Promise<TxResult> {
    return this.client.submitTxCommit({
      type: "CancelOrder",
      data: { orderId, owner: this.owner },
    });
  }

  /**
   * Atomically cancel a resting order and place its replacement (single tx).
   * Cheaper and safer than cancel-then-place: the quote is never absent in
   * between. Returns the new engine order id when the event carries it.
   */
  async cancelReplaceCommit(p: {
    cancelOrderId: bigint;
    market: number;
    side: Side;
    price: bigint;
    quantity: bigint;
    postOnly?: boolean;
    timeInForce?: TimeInForce;
  }): Promise<PlaceResult> {
    const tx = await this.client.submitTxCommit({
      type: "CancelReplaceOrder",
      data: {
        owner: this.owner,
        cancelOrderId: p.cancelOrderId,
        market: p.market,
        side: p.side,
        price: p.price,
        quantity: p.quantity,
        postOnly: p.postOnly,
        timeInForce: p.timeInForce,
      },
    });
    return { tx, orderId: extractOrderId(tx.events) };
  }

  /**
   * Kill-switch primitive: cancel every resting order for our wallet, optionally
   * scoped to one market. One tx, regardless of how many orders rest.
   */
  cancelAllOrdersCommit(market?: number): Promise<TxResult> {
    return this.client.submitTxCommit({
      type: "CancelAllOrders",
      data: { owner: this.owner, market: market ?? null },
    });
  }

  /**
   * Net signed position (lots) on a market: +long / -short / 0 flat. Reads the
   * account and folds its positions so callers never touch raw SDK position
   * shapes. Returns 0 when the account or market has no position.
   */
  async netPosition(market: number): Promise<bigint> {
    const acct = await this.account();
    if (!acct) return 0n;
    let net = 0n;
    for (const pos of acct.positions) {
      if (pos.market !== market) continue;
      net += pos.side === "Buy" ? pos.size : -pos.size;
    }
    return net;
  }

  disconnect() {
    this.client.disconnect();
  }
}

/**
 * Extract the engine order id from a tx's ABCI events. The OrderPlaced event
 * exposes the id under a key like "orderId"/"order_id"; we scan defensively
 * because exact ABCI attribute casing is gateway-defined.
 */
export function extractOrderId(events: TxEvent[] | undefined): bigint | null {
  if (!events) return null;
  for (const ev of events) {
    // ABCI event type is snake_case on this gateway: "order_placed".
    if (!/order_?placed/i.test(ev.type)) continue;
    for (const a of ev.attributes ?? []) {
      if (/^order_?id$/i.test(a.key) && /^\d+$/.test(a.value)) {
        return BigInt(a.value);
      }
    }
  }
  return null;
}

/** JSON.stringify replacer that renders BigInt as a decimal string. */
export function bigintJson(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}
