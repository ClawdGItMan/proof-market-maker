/**
 * Crash-recovery journal + startup reconciliation (ELO-10 reliability).
 *
 * The in-memory OrderTracker resets on every restart, so after a crash the bot
 * has no record of what it left resting on the exchange. The exchange, however,
 * is the source of truth — it still holds those orders. Two pieces close the gap:
 *
 *   1. A durable append-only journal (JSONL): every order intent (place / cancel
 *      / cancel-all / inferred fill) is appended *before and after* the network
 *      call, so a crash mid-submit leaves a breadcrumb of what was in flight.
 *
 *   2. `findOrphans` (pure): given the exchange's current resting orders and the
 *      set of ids the bot currently recognises, return the ids the bot does NOT
 *      recognise. On a cold restart the recognised set is empty, so *every*
 *      resting order is an orphan and gets cancelled — a clean slate, the
 *      strongest guarantee against orphan orders the chaos tests look for.
 *
 * Appends are line-buffered JSONL with a trailing newline per record; a torn
 * final line on crash is simply skipped by `readAll`, never corrupting earlier
 * records.
 */
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type JournalKind = "place" | "cancel" | "cancelAll" | "fill" | "boot";

export interface JournalEntry {
  ts: number;
  kind: JournalKind;
  /** Order id as a decimal string (BigInt is not JSON-native). */
  id?: string;
  /** Free-form phase marker, e.g. "submit" | "ack" | "reject". */
  phase?: string;
  note?: string;
}

export class Journal {
  constructor(private readonly path: string) {}

  /** Append one record durably as a single JSONL line. */
  append(entry: JournalEntry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf8");
  }

  /** Read every well-formed record; a torn trailing line is skipped, not fatal. */
  readAll(): JournalEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const out: JournalEntry[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as JournalEntry);
      } catch {
        // torn/partial line (e.g. crash mid-append) — skip it
      }
    }
    return out;
  }
}

/**
 * Resting orders on the exchange that the bot does not recognise.
 *
 * @param exchangeIds  ids currently resting on the exchange (source of truth)
 * @param known        ids the bot believes it owns (`tracker` keys, as strings)
 * @returns the subset of `exchangeIds` not present in `known` — the orphans to cancel
 */
export function findOrphans(exchangeIds: bigint[], known: Set<string>): bigint[] {
  return exchangeIds.filter((id) => !known.has(id.toString()));
}
