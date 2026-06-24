/**
 * Structured logging (pino) for the bot.
 *
 * Two non-obvious guards live here:
 *  - **BigInt safety.** Prices/sizes are BigInt end-to-end, but pino serializes
 *    with JSON.stringify, which *throws* on BigInt. The `log` formatter deep-
 *    converts BigInt → decimal string so an accidental `{ price }` field can
 *    never crash the trading loop.
 *  - **Secret safety.** `redact` censors any private-key-ish field path. We also
 *    never pass key material as a log field, but defense in depth is cheap.
 */
import { pino, type Logger as PinoLogger } from "pino";
import type { Config } from "./config.js";

export type Logger = PinoLogger;

/** Recursively replace BigInt with its decimal string. Depth-limited so a
 *  cyclic or huge object can't wedge the logger. */
function deBigint(value: unknown, depth = 0): unknown {
  if (typeof value === "bigint") return value.toString();
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => deBigint(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = deBigint(v, depth + 1);
  }
  return out;
}

export function createLogger(cfg: Config): Logger {
  const pretty = process.env.PINO_PRETTY === "1";
  return pino({
    level: cfg.logLevel,
    base: undefined, // drop pid/hostname noise
    redact: {
      paths: [
        "privateKey",
        "privateKeyHex",
        "PROOF_PRIVATE_KEY",
        "*.privateKey",
        "*.privateKeyHex",
      ],
      censor: "[redacted]",
    },
    formatters: {
      log: (obj) => deBigint(obj) as Record<string, unknown>,
    },
    ...(pretty
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "" },
          },
        }
      : {}),
  });
}
