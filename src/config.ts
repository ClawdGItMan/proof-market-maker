import { z } from "zod";

/**
 * Runtime configuration, validated at the process boundary.
 *
 * Secrets (PROOF_PRIVATE_KEY) are loaded from env only and never logged.
 * The private key is a 64-char hex string (32-byte Ed25519 seed).
 */
const EnvSchema = z.object({
  PROOF_PRIVATE_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "PROOF_PRIVATE_KEY must be 64 hex chars (32-byte seed)"),
  PROOF_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "PROOF_ADDRESS must be a 0x-prefixed 20-byte hex address"),
  PROOF_GATEWAY_URL: z.string().url().default("https://api.dev.proof.trade"),
  PROOF_CHAIN_ID: z.string().default("exchange-devnet-1"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = {
  privateKeyHex: string;
  addressHex: string;
  gatewayUrl: string;
  chainId: string;
  logLevel: "debug" | "info" | "warn" | "error";
};

export function loadConfig(): Config {
  const parsed = EnvSchema.parse(process.env);
  return {
    privateKeyHex: parsed.PROOF_PRIVATE_KEY,
    addressHex: parsed.PROOF_ADDRESS.toLowerCase(),
    gatewayUrl: parsed.PROOF_GATEWAY_URL,
    chainId: parsed.PROOF_CHAIN_ID,
    logLevel: parsed.LOG_LEVEL,
  };
}

/** Redact a hex secret for safe logging: show length only, never bytes. */
export function redact(_secret: string): string {
  return "[redacted]";
}
