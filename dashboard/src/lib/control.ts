// SERVER-ONLY. The kill-switch write path.
//
// Trust boundary (ELO-13 §7 / ELO-17): the dashboard never holds the Supabase
// service-role key. It presents a narrow, control-scoped shared secret to the
// dashboard-rpc Edge Function, which performs the privileged bot_control upsert
// inside Supabase. A leaked DASHBOARD_CONTROL_SECRET can only flip the kill-switch
// mode — it cannot forge bot_state/audit rows (the function's op-scoping denies it).
//
// This module reads a non-public env var (DASHBOARD_CONTROL_SECRET) and must never
// be imported into a Client Component. The guard below fails loudly if it ever is.

import type { KillMode } from "./types";

if (typeof window !== "undefined") {
  throw new Error("control.ts is server-only and must not be bundled for the browser");
}

export interface ControlResult {
  ok: boolean;
  error?: string;
  /** The monotonic command stamp written — the bot's bridge applies only fresher commands. */
  updatedAtMs?: number;
}

export async function writeControl(
  market: number,
  mode: KillMode,
  updatedBy: string,
  now: number,
): Promise<ControlResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.DASHBOARD_CONTROL_SECRET;
  if (!url) return { ok: false, error: "NEXT_PUBLIC_SUPABASE_URL not configured" };
  if (!secret) return { ok: false, error: "DASHBOARD_CONTROL_SECRET not configured (kill-switch disabled)" };

  const fn = `${url.replace(/\/$/, "")}/functions/v1/dashboard-rpc`;
  const control = { market, mode, updated_at_ms: now, updated_by: updatedBy };

  let res: Response;
  try {
    res = await fetch(fn, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ op: "control", control }),
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, error: `network error: ${String(e)}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `dashboard-rpc control -> ${res.status} ${body.slice(0, 200)}` };
  }
  return { ok: true, updatedAtMs: now };
}
