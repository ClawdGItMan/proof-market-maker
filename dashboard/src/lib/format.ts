// BigInt-safe formatting. Every numeric the bot publishes is a decimal STRING that
// may exceed Number.MAX_SAFE_INTEGER (u64 order ids, µUSDC prices). We parse with
// BigInt and format by hand — never with Number(), which would silently round.

const MICRO = 1_000_000n; // 1 USDC = 1e6 µUSDC

/** Format a signed bigint as a grouped decimal string with `decimals` fractional digits. */
function fixed(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  const groupedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fracStr = decimals > 0 ? "." + frac.toString().padStart(decimals, "0") : "";
  return (neg ? "-" : "") + groupedWhole + fracStr;
}

/** Parse a decimal string to BigInt, or null on null/empty/garbage. */
export function toBig(s: string | null | undefined): bigint | null {
  if (s === null || s === undefined || s === "") return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

/** µUSDC string → "$1,234.560000" (USDC). Returns "—" for null. */
export function microUsdc(s: string | null | undefined): string {
  const v = toBig(s);
  if (v === null) return "—";
  const sign = v < 0n ? "-" : "";
  return `${sign}$${fixed(v < 0n ? -v : v, 6)}`;
}

/** Net position in integer lots, with explicit sign. */
export function lots(s: string | null | undefined): string {
  const v = toBig(s);
  if (v === null) return "—";
  if (v === 0n) return "0";
  const sign = v > 0n ? "+" : "-";
  return `${sign}${fixed(v < 0n ? -v : v, 0)}`;
}

/** Raw µUSDC price string → grouped integer µUSDC (no decimal — prices are integers). */
export function price(s: string | null | undefined): string {
  const v = toBig(s);
  if (v === null) return "—";
  return fixed(v, 0);
}

/** Human "3s ago" / "2m ago" from a millis-epoch and a reference now. */
export function ago(tsMs: number | null | undefined, nowMs: number): string {
  if (!tsMs) return "never";
  const d = Math.max(0, nowMs - tsMs);
  if (d < 1000) return "just now";
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  return `${Math.floor(d / 3_600_000)}h ago`;
}

export { MICRO };
