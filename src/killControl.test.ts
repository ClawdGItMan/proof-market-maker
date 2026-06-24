import { describe, it, expect, afterEach } from "vitest";
import { rmSync, readFileSync } from "node:fs";
import { parseKillMode, KillControl } from "./killControl.js";

describe("parseKillMode", () => {
  it("defaults to run for missing / empty / unknown input", () => {
    expect(parseKillMode(null)).toBe("run");
    expect(parseKillMode("")).toBe("run");
    expect(parseKillMode("   ")).toBe("run");
    expect(parseKillMode("run")).toBe("run");
    expect(parseKillMode("banana")).toBe("run");
  });

  it("recognises hard aliases (case/whitespace-insensitive)", () => {
    for (const s of ["hard", "HARD", " halt \n", "kill", "stop"]) {
      expect(parseKillMode(s)).toBe("hard");
    }
  });

  it("recognises soft aliases", () => {
    for (const s of ["soft", "SOFT", " pause "]) {
      expect(parseKillMode(s)).toBe("soft");
    }
  });
});

describe("KillControl file round-trip", () => {
  const path = ".tmp/test-control";
  afterEach(() => {
    try {
      rmSync(path, { force: true });
    } catch {
      /* ignore */
    }
  });

  it("reads run when the file does not exist", () => {
    const kc = new KillControl(path);
    expect(kc.read()).toBe("run");
  });

  it("persists and reads back each mode", () => {
    const kc = new KillControl(path);
    kc.set("soft");
    expect(kc.read()).toBe("soft");
    kc.set("hard");
    expect(kc.read()).toBe("hard");
    // file is human-readable (operator can cat / echo it)
    expect(readFileSync(path, "utf8").trim()).toBe("hard");
    kc.set("run");
    expect(kc.read()).toBe("run");
  });
});
