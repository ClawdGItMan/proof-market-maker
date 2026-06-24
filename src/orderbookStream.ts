import { OrderbookFrame, type SnapshotFrameT, type UpdateFrameT } from "./schemas.js";

/**
 * Orderbook stream client for the live devnet gateway.
 *
 * The bundled SDK's `subscribeOrderbookDeltas` targets `/orderbook-deltas`
 * (404 on this deployment) with a frame protocol that does not match. The real
 * gateway exposes a single multiplexed socket at `<gateway>/ws` and expects:
 *
 *   ->  {"method":"subscribe","params":{"channel":"orderbook","market":<id>}}
 *   <-  {"type":"subscribed", ...}
 *   <-  {"type":"snapshot", bids:[[p,q,n]...], asks:[[p,q,n]...]}
 *   <-  {"type":"update", side, price, totalQuantity, orderCount}   (repeated)
 *
 * This client validates every inbound frame with Zod before it reaches the
 * book, and self-reconnects with capped exponential backoff + jitter,
 * re-subscribing and signalling resync on each reconnect.
 */
export interface OrderbookStreamHandlers {
  onSnapshot: (s: SnapshotFrameT) => void;
  onUpdate: (u: UpdateFrameT) => void;
  onSubscribed?: () => void;
  /** Validation / parse / server-error frames. Stream keeps reconnecting. */
  onError?: (err: unknown) => void;
  /** Fired right before a reconnect attempt so callers can mark the book stale. */
  onReconnect?: () => void;
  /**
   * Called on every socket open with a `forceDrop` closure that closes the
   * current socket, exercising the reconnect/resync path on demand. Used by the
   * resync demo to simulate an unexpected drop without reaching into internals.
   */
  onSocket?: (forceDrop: () => void) => void;
}

function wsBaseFrom(gatewayUrl: string): string {
  return gatewayUrl.replace(/\/+$/, "").replace(/^http/, "ws") + "/ws";
}

export function streamOrderbook(
  gatewayUrl: string,
  market: number,
  h: OrderbookStreamHandlers,
  opts: { backoffCapMs?: number } = {},
): () => void {
  const url = wsBaseFrom(gatewayUrl);
  const sub = JSON.stringify({ method: "subscribe", params: { channel: "orderbook", market } });
  const capMs = opts.backoffCapMs ?? 30_000;

  let closed = false;
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let backoff = 500;
  let firstConnect = true;

  const scheduleReconnect = () => {
    if (closed) return;
    h.onReconnect?.();
    const jitter = backoff * (0.75 + Math.random() * 0.5);
    timer = setTimeout(connect, jitter);
    backoff = Math.min(backoff * 2, capMs);
  };

  function connect() {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      backoff = 500;
      if (!firstConnect) h.onReconnect?.();
      firstConnect = false;
      ws?.send(sub);
      // Hand the caller a way to force-drop *this* socket (for resync drills).
      const sock = ws;
      h.onSocket?.(() => {
        try {
          sock?.close();
        } catch {
          /* ignore */
        }
      });
    };
    ws.onmessage = (ev) => {
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data as string);
      } catch (e) {
        h.onError?.(e);
        return;
      }
      const parsed = OrderbookFrame.safeParse(raw);
      if (!parsed.success) {
        h.onError?.(new Error(`frame failed validation: ${parsed.error.message}`));
        return;
      }
      const frame = parsed.data;
      switch (frame.type) {
        case "subscribed":
          h.onSubscribed?.();
          break;
        case "snapshot":
          h.onSnapshot(frame);
          break;
        case "update":
          h.onUpdate(frame);
          break;
        case "error":
          h.onError?.(new Error(`gateway error frame: ${frame.error}`));
          break;
      }
    };
    ws.onerror = (e: unknown) => h.onError?.(e);
    ws.onclose = () => {
      ws = null;
      if (!closed) scheduleReconnect();
    };
  }

  connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
  };
}
