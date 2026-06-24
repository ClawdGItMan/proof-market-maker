/**
 * Two-tier kill-switch via a local control file (ELO-10 reliability).
 *
 * A single file (default `data/control`) holds the desired operating mode. The
 * bot reads it every tick; the `killswitch` CLI and the dashboard write it. A
 * file is the right channel here: it is atomic to swap (temp + rename), survives
 * process restarts, needs no network, and can be flipped by a human with `echo`
 * even if every other control plane is down.
 *
 * Modes:
 *   - `run`  — normal two-sided quoting.
 *   - `soft` — stop placing NEW quotes but leave resting orders in the book and
 *              keep reconciling fills. Use to pause without churning the book.
 *   - `hard` — pull every quote (atomic cancel-all) and halt. Use to flatten and
 *              stop in one move when something looks wrong.
 *
 * `parseKillMode` is pure and exported so the mode grammar is unit-tested
 * independently of the filesystem.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type KillMode = "run" | "soft" | "hard";

/** Map raw file contents (or null when missing) to a mode. Defaults to `run`. */
export function parseKillMode(raw: string | null): KillMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "hard" || v === "halt" || v === "kill" || v === "stop") return "hard";
  if (v === "soft" || v === "pause") return "soft";
  return "run"; // empty, missing, "run", or anything unrecognised → keep running
}

export class KillControl {
  constructor(private readonly path: string) {}

  /** Current mode; `run` when the file is missing or unreadable. */
  read(): KillMode {
    try {
      return parseKillMode(readFileSync(this.path, "utf8"));
    } catch {
      return "run";
    }
  }

  /** Atomically set the mode (temp-file + rename), so a reader never sees a torn write. */
  set(mode: KillMode): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${mode}\n`, "utf8");
    renameSync(tmp, this.path);
  }
}
