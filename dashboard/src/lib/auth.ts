// Operator authentication for the ops dashboard.
//
// The dashboard exposes a privileged action (the kill-switch). A Next.js Server
// Action is a publicly reachable POST endpoint, so it must authenticate its OWN
// caller — it cannot assume the page in front of it gated access. We use HTTP Basic
// Auth with a single operator credential from env (proportionate for a solo-operator
// tool; SSO/Clerk is the documented upgrade path).
//
// FAIL CLOSED: if no credential is configured, auth fails. The dashboard must never
// be served open — an unauthenticated kill-switch is a DoS on the trading strategy.

/** Constant-time string compare (avoids leaking length-prefix matches via timing). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function decodeBase64(s: string): string {
  // Available in both the Edge runtime (middleware) and Node (server actions).
  if (typeof atob === "function") return atob(s);
  return Buffer.from(s, "base64").toString("utf8");
}

/** Parse a `Basic <base64(user:pass)>` header into its parts, or null if malformed. */
export function parseBasicAuth(header: string | null | undefined): { user: string; pass: string } | null {
  if (!header || !header.startsWith("Basic ")) return null;
  let decoded: string;
  try {
    decoded = decodeBase64(header.slice(6).trim());
  } catch {
    return null;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

/**
 * Verify a Basic-Auth header against the configured operator credential.
 * Returns the operator id (username) on success, or null on any failure —
 * including when the credential env is unset (fail closed).
 */
export function verifyBasicAuth(header: string | null | undefined): string | null {
  const user = process.env.DASHBOARD_BASIC_AUTH_USER;
  const pass = process.env.DASHBOARD_BASIC_AUTH_PASSWORD;
  if (!user || !pass) return null; // not configured → no one is authenticated
  const creds = parseBasicAuth(header);
  if (!creds) return null;
  // Evaluate both compares (no short-circuit) so timing doesn't reveal which half matched.
  const okUser = timingSafeEqual(creds.user, user);
  const okPass = timingSafeEqual(creds.pass, pass);
  return okUser && okPass ? creds.user : null;
}
