import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { POST } from "@/app/api/auth/request/route";

/**
 * Regression guard for the critical account-takeover hole found in the red-team:
 * /api/auth/request must NEVER return the passwordless login OTP in its response.
 * Returning it (the old devCode default) let anyone request a code for any email
 * and log in as that customer. The code may only travel by email + magic link;
 * the response is a generic { ok: true }. The local-dev shortcut is now OFF by
 * default and gated behind AUTH_DEV_RETURN_CODE (which is unset in the test env).
 *
 * A unique User-Agent gives this test its own rate-limit bucket so it never
 * collides with other auth-tier route tests under --no-file-parallelism.
 */
function post(email: string) {
  const req = new Request("http://localhost:3000/api/auth/request", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "otp-leak-regression-test",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify({ email }),
  });
  return POST(req, { params: Promise.resolve({}) });
}

describe("POST /api/auth/request — no OTP leak", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("never returns the login code in the response (no devCode leak)", async () => {
    const res = await post("leak-check@example.com");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(body.devCode).toBeUndefined();
    expect(body.code).toBeUndefined();
  });

  it("returns the same generic body for an unknown email (no enumeration, no leak)", async () => {
    const res = await post("definitely-not-a-customer@example.com");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(body.devCode).toBeUndefined();
  });
});
