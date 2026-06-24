import { z } from "zod";

/**
 * Zod schemas for inbound gateway WebSocket frames, validated at the SDK/
 * network boundary (ELO-8 requirement). Shapes were captured live from
 * wss://api.dev.proof.trade/ws on 2026-06-24 — the SDK's built-in stream
 * types do NOT match this deployment (see README / spike notes).
 *
 * Wire numbers arrive as bare JSON numbers (price in micro-USDC, quantity in
 * 10^-szDecimals contracts). They are coerced to BigInt here so the rest of
 * the system is BigInt end-to-end. Caveat: JSON.parse has already narrowed
 * them to f64; current devnet values are < 2^53 so this is lossless today. A
 * hardened client should request string-encoded numbers or use a lossless
 * JSON parser.
 */

// number (already-parsed JSON) → BigInt, rejecting non-integers / unsafe.
const intToBigInt = z
  .number()
  .refine((n) => Number.isInteger(n) && Number.isSafeInteger(n), {
    message: "non-integer or beyond 2^53 — lossy, refuse to coerce",
  })
  .transform((n) => BigInt(n));

/** A snapshot level tuple: [price, totalQty, orderCount]. */
const LevelTuple = z
  .tuple([intToBigInt, intToBigInt, z.number().int().nonnegative()])
  .transform(([price, totalQty, orderCount]) => ({ price, totalQty, orderCount }));

export const SubscribedFrame = z.object({
  type: z.literal("subscribed"),
  channel: z.string(),
  id: z.unknown().nullable().optional(),
});

export const SnapshotFrame = z.object({
  type: z.literal("snapshot"),
  channel: z.literal("orderbook"),
  market: z.number().int(),
  bids: z.array(LevelTuple),
  asks: z.array(LevelTuple),
});

export const UpdateFrame = z.object({
  type: z.literal("update"),
  channel: z.literal("orderbook"),
  market: z.number().int(),
  side: z.enum(["buy", "sell"]),
  price: intToBigInt,
  totalQuantity: intToBigInt,
  orderCount: z.number().int().nonnegative(),
});

export const ErrorFrame = z.object({
  type: z.literal("error"),
  error: z.string(),
});

export const OrderbookFrame = z.discriminatedUnion("type", [
  SubscribedFrame,
  SnapshotFrame,
  UpdateFrame,
  ErrorFrame,
]);

export type SnapshotFrameT = z.infer<typeof SnapshotFrame>;
export type UpdateFrameT = z.infer<typeof UpdateFrame>;
export type OrderbookFrameT = z.infer<typeof OrderbookFrame>;
