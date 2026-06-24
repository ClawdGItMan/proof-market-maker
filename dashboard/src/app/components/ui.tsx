import type { KillMode } from "@/lib/types";

export function Panel({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-edge bg-panel">
      <header className="flex items-center justify-between border-b border-edge px-4 py-2">
        <h3 className="text-xs uppercase tracking-widest text-muted">{title}</h3>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Metric({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" | "neutral" }) {
  const color = tone === "pos" ? "text-run" : tone === "neg" ? "text-hard" : "text-white";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-muted">{label}</span>
      <span className={`text-xl tabular-nums ${color}`}>{value}</span>
    </div>
  );
}

const MODE_LABEL: Record<KillMode, string> = { run: "RUN", soft: "SOFT-STOP", hard: "HARD-STOP" };

export function ModeBadge({ mode }: { mode: KillMode }) {
  const cls =
    mode === "run"
      ? "border-run/40 bg-run/10 text-run"
      : mode === "soft"
        ? "border-soft/40 bg-soft/10 text-soft"
        : "border-hard/40 bg-hard/10 text-hard";
  return (
    <span className={`rounded border px-2 py-0.5 text-xs font-semibold tracking-wider ${cls}`}>
      {MODE_LABEL[mode]}
    </span>
  );
}

export function Dot({ ok }: { ok: boolean }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-run" : "bg-hard"}`} aria-hidden />;
}
