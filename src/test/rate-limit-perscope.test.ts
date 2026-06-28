import { describe, it, expect } from "vitest";
import { enforceRateLimit } from "@/lib/http/rate-limit";

/**
 * Regression guard for the red-team finding: the rate limiter was bypassable by
 * rotating the User-Agent (the in-memory fallback keys on a spoofable request
 * fingerprint when TRUST_PROXY is false). The fix adds a perScope option that
 * keys a per-victim limit (e.g. per-email login) on the scope ALONE, so rotating
 * the fingerprint can no longer reset it. These tests assert both the fix and
 * the original gap it closes, using distinct scopes so they never collide.
 */
function reqWithUA(ua: string): Request {
  return new Request("http://localhost:3000/x", {
    method: "POST",
    headers: { "user-agent": ua },
  });
}

describe("rate limiter — perScope (per-victim, fingerprint-independent)", () => {
  it("blocks despite a rotating fingerprint when perScope is set", async () => {
    const scope = "unit-perscope-victim";
    let allowed = 0;
    let blocked = false;
    for (let i = 0; i < 25; i++) {
      try {
        await enforceRateLimit(reqWithUA(`ua-${i}`), "auth", scope, { perScope: true });
        allowed++;
      } catch {
        blocked = true;
        break;
      }
    }
    // The per-victim bucket is hit even though every request used a different UA.
    expect(blocked).toBe(true);
    expect(allowed).toBeLessThan(25);
  });

  it("without perScope, a rotating fingerprint resets the bucket (the gap the fix closes)", async () => {
    const scope = "unit-noscope-victim";
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      try {
        await enforceRateLimit(reqWithUA(`ua2-${i}`), "auth", scope);
        allowed++;
      } catch {
        break;
      }
    }
    // Each distinct UA is a fresh fingerprint bucket, so none are ever blocked.
    expect(allowed).toBe(20);
  });
});
