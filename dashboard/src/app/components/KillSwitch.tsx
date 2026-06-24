"use client";

import { useState, useTransition } from "react";
import { setControlMode } from "../actions";
import type { KillMode } from "@/lib/types";

const TIERS: { mode: KillMode; label: string; hint: string }[] = [
  { mode: "run", label: "RUN", hint: "resume quoting" },
  { mode: "soft", label: "SOFT", hint: "stop quoting, keep resting orders" },
  { mode: "hard", label: "HARD", hint: "cancel everything, flatten" },
];

function tierClasses(mode: KillMode, active: boolean): string {
  const base = "flex-1 rounded border px-3 py-2 text-sm font-semibold tracking-wider transition disabled:opacity-50";
  if (mode === "run") return `${base} ${active ? "border-run bg-run/20 text-run" : "border-edge text-muted hover:border-run/60"}`;
  if (mode === "soft") return `${base} ${active ? "border-soft bg-soft/20 text-soft" : "border-edge text-muted hover:border-soft/60"}`;
  return `${base} ${active ? "border-hard bg-hard/20 text-hard" : "border-edge text-muted hover:border-hard/60"}`;
}

export function KillSwitch({
  market,
  appliedMode,
  desiredMode,
  onChanged,
}: {
  market: number;
  appliedMode: KillMode | null;
  desiredMode: KillMode | null;
  onChanged: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmHard, setConfirmHard] = useState(false);

  function submit(mode: KillMode) {
    setError(null);
    startTransition(async () => {
      const res = await setControlMode({ market, mode, confirmHard: mode === "hard" ? true : undefined });
      if (!res.ok) setError(res.error ?? "control write failed");
      else onChanged();
      setConfirmHard(false);
    });
  }

  function onClick(mode: KillMode) {
    if (mode === "hard") setConfirmHard(true);
    else submit(mode);
  }

  // "Desired ≠ applied" means a command is in flight to the bot but not yet echoed back.
  const inFlight = desiredMode !== null && appliedMode !== null && desiredMode !== appliedMode;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        {TIERS.map((t) => (
          <button
            key={t.mode}
            type="button"
            disabled={pending}
            onClick={() => onClick(t.mode)}
            title={t.hint}
            className={tierClasses(t.mode, appliedMode === t.mode)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-[18px] text-xs">
        {pending && <span className="text-muted">writing…</span>}
        {!pending && inFlight && (
          <span className="text-soft">desired {desiredMode?.toUpperCase()} — waiting for bot to echo…</span>
        )}
        {!pending && !inFlight && error === null && <span className="text-muted">applied: {appliedMode?.toUpperCase() ?? "—"}</span>}
        {error && <span className="text-hard">{error}</span>}
      </div>

      {confirmHard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-lg border border-hard/50 bg-panel p-5">
            <h4 className="text-base font-semibold text-hard">Confirm HARD stop — market {market}</h4>
            <p className="mt-2 text-sm text-muted">
              This cancels all resting orders and flattens inventory on market {market}. The bot will not quote again until
              you set it back to RUN. Proceed?
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded border border-edge px-4 py-2 text-sm text-muted hover:text-white"
                onClick={() => setConfirmHard(false)}
                disabled={pending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded border border-hard bg-hard/20 px-4 py-2 text-sm font-semibold text-hard"
                onClick={() => submit("hard")}
                disabled={pending}
              >
                {pending ? "writing…" : "HARD STOP"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
