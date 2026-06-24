import type { MarketView } from "@/lib/types";
import { ago, lots, microUsdc, price, toBig } from "@/lib/format";
import { Dot, Metric, ModeBadge, Panel } from "./ui";
import { KillSwitch } from "./KillSwitch";

// If the bot's heartbeat is older than this, the feed is treated as stale even if
// the published `stale` flag is false (covers the bot dying without publishing).
const HEARTBEAT_STALE_MS = 15_000;

export function MarketCard({ view, nowMs, onChanged }: { view: MarketView; nowMs: number; onChanged: () => void }) {
  const { market, state, orders, audit, control } = view;

  const heartbeatAge = state ? nowMs - state.heartbeat_at : Infinity;
  const heartbeatStale = heartbeatAge > HEARTBEAT_STALE_MS;
  const feedStale = (state?.stale ?? true) || heartbeatStale;
  const pnlBig = toBig(state?.pnl);

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-edge bg-ink p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold">Market {market}</h2>
          {state ? <ModeBadge mode={state.mode} /> : <span className="text-xs text-muted">no snapshot yet</span>}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <Dot ok={!feedStale} />
          <span>{feedStale ? "FEED STALE" : "FEED LIVE"}</span>
          <span>· heartbeat {state ? ago(state.heartbeat_at, nowMs) : "never"}</span>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Panel title="PnL (estimate)">
          <Metric
            label="Total PnL · marked at mid"
            value={microUsdc(state?.pnl)}
            tone={pnlBig === null ? "neutral" : pnlBig >= 0n ? "pos" : "neg"}
          />
          <p className="mt-2 text-[10px] leading-relaxed text-muted">
            Maker estimate from inferred fills, marked at current mid. Not exchange-confirmed.
          </p>
        </Panel>

        <Panel title="Inventory">
          <div className="grid grid-cols-2 gap-4">
            <Metric label="Net position (lots)" value={lots(state?.net_position)} tone={
              state && toBig(state.net_position) !== 0n ? (toBig(state.net_position)! > 0n ? "pos" : "neg") : "neutral"
            } />
            <Metric label="Mid (µUSDC)" value={price(state?.mid)} />
            <Metric label="Best bid" value={price(state?.best_bid)} />
            <Metric label="Best ask" value={price(state?.best_ask)} />
          </div>
        </Panel>

        <Panel title="Feed / connection health">
          <div className="grid grid-cols-2 gap-4">
            <Metric label="Stale flag" value={state?.stale ? "STALE" : "fresh"} tone={state?.stale ? "neg" : "pos"} />
            <Metric
              label="Stale since"
              value={state?.stale_since_ms != null ? `${state.stale_since_ms} ms` : "—"}
            />
            <Metric label="Resyncs" value={state ? String(state.resyncs) : "—"} />
            <Metric label="Open orders" value={state ? String(state.open_order_count) : "—"} />
          </div>
        </Panel>

        <Panel
          title="Kill switch"
          right={control ? <span className="text-[10px] text-muted">desired: {control.mode.toUpperCase()} · {ago(control.updated_at_ms, nowMs)}</span> : null}
        >
          <KillSwitch
            market={market}
            appliedMode={state?.mode ?? null}
            desiredMode={control?.mode ?? null}
            onChanged={onChanged}
          />
        </Panel>
      </div>

      <Panel title={`Open orders (${orders.length})`}>
        {orders.length === 0 ? (
          <p className="text-sm text-muted">No resting orders.</p>
        ) : (
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-muted">
                <th className="py-1 pr-4">Side</th>
                <th className="py-1 pr-4">Price (µUSDC)</th>
                <th className="py-1 pr-4">Qty (lots)</th>
                <th className="py-1">Order id</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.order_id} className="border-t border-edge/60">
                  <td className={`py-1 pr-4 font-semibold ${o.side === "buy" ? "text-run" : "text-hard"}`}>{o.side.toUpperCase()}</td>
                  <td className="py-1 pr-4">{price(o.price)}</td>
                  <td className="py-1 pr-4">{price(o.quantity)}</td>
                  <td className="py-1 text-muted">{o.order_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title={`Audit log (latest ${audit.length})`}>
        {audit.length === 0 ? (
          <p className="text-sm text-muted">No events.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {audit.map((a) => (
              <li key={a.id} className="flex gap-3 border-t border-edge/40 py-1">
                <span className="w-20 shrink-0 text-muted">{ago(a.ts, nowMs)}</span>
                <span className="w-24 shrink-0 font-semibold uppercase">{a.kind}</span>
                <span className="text-muted">
                  {a.order_id ? `#${a.order_id} ` : ""}
                  {a.note ?? ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
