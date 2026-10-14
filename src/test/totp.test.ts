import { describe, it, expect } from "vitest";
import { verifyTotp, otpauthUri, base32Encode, generateTotpSecret, TOTP_PERIOD_SECONDS } from "@/lib/auth/totp";

// RFC 6238 Appendix B test secret (ASCII "12345678901234567890", SHA-1).
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC 6238 SHA-1 test vector at T=59s (code 287082, 6 digits)", () => {
    // RFC vector is 8 digits (94287082); the standard 6-digit truncation is 287082.
    const result = verifyTotp(RFC_SECRET, "287082", 0, 59_000);
    expect(result.ok).toBe(true);
    expect(result.usedStep).toBe(1);
  });

  it("matches the RFC vector at T=1111111109s (code 081804)", () => {
    const result = verifyTotp(RFC_SECRET, "081804", 0, 1_111_111_109_000);
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong code", () => {
    expect(verifyTotp(RFC_SECRET, "000000", 0, 59_000).ok).toBe(false);
  });

  it("rejects replay of an already-used step", () => {
    const first = verifyTotp(RFC_SECRET, "287082", 0, 59_000);
    expect(first.ok).toBe(true);
    const replay = verifyTotp(RFC_SECRET, "287082", first.usedStep!, 59_000);
    expect(replay.ok).toBe(false);
  });

  it("accepts one step of clock drift in both directions, rejects two", () => {
    const at = 1_111_111_109_000; // step N
    const stepMs = TOTP_PERIOD_SECONDS * 1000;
    // code valid for step N, submitted one period later (drift -1): accepted
    expect(verifyTotp(RFC_SECRET, "081804", 0, at + stepMs).ok).toBe(true);
    // submitted two periods later: rejected
    expect(verifyTotp(RFC_SECRET, "081804", 0, at + 2 * stepMs).ok).toBe(false);
  });

  it("rejects malformed input without throwing", () => {
    expect(verifyTotp(RFC_SECRET, 287082 as unknown, 0).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET, "12 34 56 78", 0).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET, "abcdef", 0).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET, null, 0).ok).toBe(false);
  });

  it("builds a well-formed, URL-encoded otpauth URI", () => {
    const secret = generateTotpSecret();
    const uri = otpauthUri("owner@fleetdesk.app", secret);
    expect(uri).toMatch(/^otpauth:\/\/totp\/Yabi%20Desk%3Aowner%40fleetdesk\.app\?secret=[A-Z2-7]+&issuer=Yabi%20Desk&algorithm=SHA1&digits=6&period=30$/);
    expect(uri).toContain(base32Encode(secret));
  });

  it("generates 160-bit secrets", () => {
    expect(generateTotpSecret().length).toBe(20);
  });
});
