import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { issueLoginToken, verifyLoginToken, TOKEN_TTL_MINUTES, MAX_ATTEMPTS } from "@/lib/auth/customer-login";

beforeAll(async () => { await runMigrations(); });

describe("customer passwordless login tokens", () => {
  it("issues a 6-digit code and verifies it once", async () => {
    const { code } = await issueLoginToken("Login@Test.com");
    expect(code).toMatch(/^\d{6}$/);
    const r = await verifyLoginToken("login@test.com", code); // case-insensitive email
    expect(r.ok).toBe(true);
    // single-use: the same code no longer works
    expect((await verifyLoginToken("login@test.com", code)).ok).toBe(false);
  });

  it("rejects a wrong code and caps attempts", async () => {
    const email = "cap@test.com";
    const { code } = await issueLoginToken(email);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect((await verifyLoginToken(email, "000000")).ok).toBe(false);
    }
    // even the CORRECT code now fails (attempts capped)
    expect((await verifyLoginToken(email, code)).ok).toBe(false);
  });

  it("rejects an expired code", async () => {
    const email = "exp@test.com";
    const { code } = await issueLoginToken(email);
    const later = new Date(Date.now() + (TOKEN_TTL_MINUTES + 1) * 60_000);
    expect((await verifyLoginToken(email, code, later)).ok).toBe(false);
  });

  it("issuing a new code invalidates the previous one", async () => {
    const email = "rotate@test.com";
    const first = await issueLoginToken(email);
    await issueLoginToken(email); // invalidates first
    expect((await verifyLoginToken(email, first.code)).ok).toBe(false);
  });

  it("rejects malformed input without throwing", async () => {
    await issueLoginToken("mal@test.com");
    expect((await verifyLoginToken("mal@test.com", "abc")).ok).toBe(false);
    expect((await verifyLoginToken("mal@test.com", 123456 as unknown)).ok).toBe(false);
    expect((await verifyLoginToken("nobody@test.com", "000000")).ok).toBe(false);
  });
});
