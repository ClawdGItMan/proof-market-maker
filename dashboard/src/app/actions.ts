"use server";

// Kill-switch server action (ELO-17). This is a trust boundary: a Server Action
// endpoint is publicly reachable, so every input is validated with Zod before the
// privileged control write. The secret never leaves the server (see lib/control.ts).

import { headers } from "next/headers";
import { z } from "zod";
import { writeControl } from "@/lib/control";
import { verifyBasicAuth } from "@/lib/auth";

const Input = z.object({
  market: z.number().int().nonnegative(),
  mode: z.enum(["run", "soft", "hard"]),
  // `hard` is the destructive tier — require the client to echo an explicit
  // confirmation token so a stray/replayed request can't trip a full stop.
  confirmHard: z.boolean().optional(),
});

export interface ActionResult {
  ok: boolean;
  error?: string;
  mode?: "run" | "soft" | "hard";
  updatedAtMs?: number;
}

export async function setControlMode(raw: unknown): Promise<ActionResult> {
  // Defense-in-depth: re-authenticate the caller inside the action itself. A Server
  // Action is a public POST endpoint, so we never rely solely on the edge middleware.
  const operator = verifyBasicAuth(headers().get("authorization"));
  if (!operator) {
    return { ok: false, error: "unauthorized — operator authentication required" };
  }

  const parsed = Input.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  const { market, mode, confirmHard } = parsed.data;

  if (mode === "hard" && confirmHard !== true) {
    return { ok: false, error: "hard stop requires explicit confirmation" };
  }

  // Monotonic command stamp — the bot's control bridge applies only commands fresher
  // than the last one it has seen (see src/controlBridge.ts resolveControl).
  const now = Date.now();
  // Attribute the write to the real operator (lands in bot_control.updated_by / audit).
  const result = await writeControl(market, mode, `operator:${operator}`, now);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, mode, updatedAtMs: result.updatedAtMs };
}
