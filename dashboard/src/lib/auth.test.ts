import { afterEach, describe, expect, it } from "vitest";
import { parseBasicAuth, timingSafeEqual, verifyBasicAuth } from "./auth";

const basic = (user: string, pass: string) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

afterEach(() => {
  delete process.env.DASHBOARD_BASIC_AUTH_USER;
  delete process.env.DASHBOARD_BASIC_AUTH_PASSWORD;
});

describe("timingSafeEqual", () => {
  it("matches equal strings and rejects any difference (incl. length)", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
  });
});

describe("parseBasicAuth", () => {
  it("decodes a well-formed header, preserving colons in the password", () => {
    expect(parseBasicAuth(basic("ops", "p:a:ss"))).toEqual({ user: "ops", pass: "p:a:ss" });
  });
  it("rejects missing/non-Basic/garbage headers", () => {
    expect(parseBasicAuth(null)).toBeNull();
    expect(parseBasicAuth("Bearer xyz")).toBeNull();
    expect(parseBasicAuth("Basic @@@notbase64@@@")).toBeNull();
  });
});

describe("verifyBasicAuth", () => {
  it("FAILS CLOSED when no credential is configured", () => {
    expect(verifyBasicAuth(basic("ops", "secret"))).toBeNull();
  });
  it("returns the operator id only on an exact match", () => {
    process.env.DASHBOARD_BASIC_AUTH_USER = "ops";
    process.env.DASHBOARD_BASIC_AUTH_PASSWORD = "secret";
    expect(verifyBasicAuth(basic("ops", "secret"))).toBe("ops");
    expect(verifyBasicAuth(basic("ops", "wrong"))).toBeNull();
    expect(verifyBasicAuth(basic("attacker", "secret"))).toBeNull();
    expect(verifyBasicAuth(null)).toBeNull();
  });
});
