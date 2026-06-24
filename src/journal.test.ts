import { describe, it, expect, afterEach } from "vitest";
import { rmSync, appendFileSync } from "node:fs";
import { Journal, findOrphans } from "./journal.js";

describe("findOrphans", () => {
  it("returns exchange orders the bot does not recognise", () => {
    const exchange = [1n, 2n, 3n];
    const known = new Set(["2"]);
    expect(findOrphans(exchange, known)).toEqual([1n, 3n]);
  });

  it("treats an empty known set (cold restart) as: everything is an orphan", () => {
    expect(findOrphans([10n, 11n], new Set())).toEqual([10n, 11n]);
  });

  it("returns nothing when the bot recognises every resting order", () => {
    expect(findOrphans([5n, 6n], new Set(["5", "6"]))).toEqual([]);
  });
});

describe("Journal", () => {
  const path = ".tmp/test-journal.jsonl";
  afterEach(() => {
    try {
      rmSync(path, { force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns no entries when the journal does not exist yet", () => {
    expect(new Journal(path).readAll()).toEqual([]);
  });

  it("appends and reads back records in order", () => {
    const j = new Journal(path);
    j.append({ ts: 1, kind: "boot" });
    j.append({ ts: 2, kind: "place", id: "42", phase: "submit" });
    j.append({ ts: 3, kind: "place", id: "42", phase: "ack" });
    const all = j.readAll();
    expect(all.map((e) => e.kind)).toEqual(["boot", "place", "place"]);
    expect(all[1]).toMatchObject({ id: "42", phase: "submit" });
  });

  it("skips a torn trailing line instead of throwing (crash mid-append)", () => {
    const j = new Journal(path);
    j.append({ ts: 1, kind: "place", id: "7", phase: "ack" });
    appendFileSync(path, '{"ts":2,"kind":"pla'); // simulate a crash mid-write
    const all = j.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: "7" });
  });
});
