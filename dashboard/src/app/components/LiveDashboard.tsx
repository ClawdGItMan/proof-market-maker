"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardData } from "@/lib/types";
import { MarketCard } from "./MarketCard";

const POLL_MS = 2_000;

export function LiveDashboard({ initial }: { initial: DashboardData }) {
  const [data, setData] = useState<DashboardData>(initial);
  const [connected, setConnected] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const next = (await res.json()) as DashboardData;
      setData(next);
      setConnected(true);
    } catch {
      // Keep showing the last-good snapshot; flag that the dashboard's own read is down.
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      await refresh();
      if (active) timer.current = setTimeout(tick, POLL_MS);
    };
    timer.current = setTimeout(tick, POLL_MS);
    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refresh]);

  // `now` for ageing timestamps: use the server's fetch clock so client/server skew
  // doesn't make a fresh heartbeat look stale.
  const nowMs = data.fetchedAt;

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Proof MM · Ops</h1>
          <p className="text-xs text-muted">read-only · live every {POLL_MS / 1000}s</p>
        </div>
        <span className={`text-xs ${connected ? "text-run" : "text-hard"}`}>
          {connected ? "● dashboard live" : "○ dashboard read failing"}
        </span>
      </header>

      {data.markets.length === 0 ? (
        <div className="rounded-lg border border-edge bg-panel p-8 text-center text-muted">
          No markets published yet. The dashboard will populate once the bot starts publishing snapshots.
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {data.markets.map((view) => (
            <MarketCard key={view.market} view={view} nowMs={nowMs} onChanged={refresh} />
          ))}
        </div>
      )}
    </main>
  );
}
