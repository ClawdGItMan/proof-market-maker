// ELO-13 dashboard write proxy (Supabase Edge Function).
//
// Why this exists: the bot must write its state past RLS, which needs the
// service-role key. Rather than ship that all-powerful key to the trading VM
// (next to the signing key), the key stays INSIDE Supabase — auto-injected into
// this function as SUPABASE_SERVICE_ROLE_KEY. Callers (the bot, and later the
// dashboard control server action) authenticate with a narrow SHARED SECRET;
// this function validates it and performs the privileged writes on their behalf.
// A leaked shared secret only grants "publish dashboard rows", never full DB
// access. Reads need no secret at all — RLS already allows anon SELECT.
//
// Deployed with verify_jwt=false: we do our OWN auth (the bot has no Supabase
// JWT). The secret is checked as sha256(presented) === embedded hash, so the
// raw secret never appears in this source.
import { createClient } from "jsr:@supabase/supabase-js@2";

// Op-scoped shared secrets (raw secrets live only in each caller's env, never here).
// Each credential is sha256(secret) → the set of ops it may invoke. This is the
// "separate blast radius" the ELO-13 design (§7) calls for: the BOT publish secret
// can publish/audit/control, but the DASHBOARD control secret (ELO-17) can ONLY
// flip the kill-switch — a leaked dashboard secret cannot forge bot_state/audit
// rows, only request a mode it is already allowed to request.
const CREDENTIALS: ReadonlyArray<{ hash: string; ops: ReadonlySet<string> }> = [
  // Bot publish secret (lives in the trading VM's .env as BOT_PUBLISH_SECRET).
  { hash: "9571e48eedc6da643fac255324210eb63a14dd5414166f11bf6831227b1ef569", ops: new Set(["publish", "audit", "control"]) },
  // Dashboard control secret (lives in the dashboard's server-side env as DASHBOARD_CONTROL_SECRET).
  { hash: "a85cc25815316e02cfeee7868541ae7fe4e5faedaf906b57cb5d99c1a31059a8", ops: new Set(["control"]) },
];

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const presentedHash = token ? await sha256Hex(token) : "";
  const credential = token ? CREDENTIALS.find((c) => timingSafeEqual(presentedHash, c.hash)) : undefined;
  if (!credential) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: { op?: string; state?: Record<string, unknown>; orders?: unknown[]; rows?: unknown[]; control?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  // Op scoping: a valid secret may only invoke the ops it was granted (least privilege).
  if (typeof body.op !== "string" || !credential.ops.has(body.op)) {
    return json({ error: "forbidden" }, 403);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    if (body.op === "publish") {
      const state = body.state;
      if (!state || typeof state.market !== "number") return json({ error: "missing state.market" }, 400);
      const market = state.market as number;
      // ELO-25: stamp updated_at server-side so the column tracks the latest tick.
      // The bot's upsert omits it, so ON CONFLICT DO UPDATE previously left the
      // column frozen at first-insert time — stale for any consumer reading it
      // directly (the dashboard itself is unaffected: it tracks the heartbeat_at
      // payload field). Override any caller-supplied value with our own clock.
      const row = { ...state, updated_at: new Date().toISOString() };
      const up = await admin.from("bot_state").upsert(row, { onConflict: "market" });
      if (up.error) throw up.error;
      const del = await admin.from("open_orders").delete().eq("market", market);
      if (del.error) throw del.error;
      if (Array.isArray(body.orders) && body.orders.length > 0) {
        const ins = await admin.from("open_orders").insert(body.orders);
        if (ins.error) throw ins.error;
      }
      return json({ ok: true });
    }

    if (body.op === "audit") {
      if (Array.isArray(body.rows) && body.rows.length > 0) {
        const ins = await admin.from("audit_log").insert(body.rows);
        if (ins.error) throw ins.error;
      }
      return json({ ok: true });
    }

    if (body.op === "control") {
      const c = body.control;
      if (!c || typeof c.market !== "number") return json({ error: "missing control.market" }, 400);
      if (c.mode !== "run" && c.mode !== "soft" && c.mode !== "hard") return json({ error: "bad mode" }, 400);
      if (typeof c.updated_at_ms !== "number" || !Number.isFinite(c.updated_at_ms)) return json({ error: "bad updated_at_ms" }, 400);
      // Only write the four known columns — never trust the caller to pick columns.
      const row = {
        market: c.market,
        mode: c.mode,
        updated_at_ms: c.updated_at_ms,
        updated_by: typeof c.updated_by === "string" ? c.updated_by.slice(0, 120) : null,
      };
      const up = await admin.from("bot_control").upsert(row, { onConflict: "market" });
      if (up.error) throw up.error;
      return json({ ok: true });
    }

    return json({ error: "unknown op" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
