// Deliberately does NOT set PAYMENT_MODE: src/test/setup.ts provides the
// Stripe keys, so this file runs in the default ONLINE mode. The desk-mode
// side of this gate lives in desk-mode-ui-config.test.ts.

import { describe, it, expect, vi } from "vitest";

// requireAdmin reads cookies via next/headers, which throws outside a live
// Next request scope; an EMPTY jar stands in (same stand-in as
// upload-body-cap.test.ts, minus the entries) so IF the request ever reached
// the admin guard it would see "no session" and answer 401. The 404
// assertion below is what proves it never gets that far: online bookings are
// confirmed by the Stripe webhook when payment lands, so the admin confirm
// route must not exist at all outside desk mode, or a staff click could
// confirm an UNPAID booking.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

describe("admin confirm route in online mode", () => {
  it("404s before auth: the route does not exist outside desk mode", async () => {
    const { POST } = await import("@/app/api/admin/bookings/[id]/confirm/route");
    const res = await POST(
      new Request("http://localhost:3000/api/admin/bookings/x/confirm", {
        method: "POST",
        headers: { "user-agent": "t" },
      }),
      { params: Promise.resolve({ id: crypto.randomUUID() }) },
    );
    expect(res.status).toBe(404);
  });
});

// The inverse gate: /api/admin/maintenance/expire-holds is BLOCKED in desk
// mode (see desk-mode-booking.test.ts) and ALLOWED here. This proves the
// desk-mode guard does not misfire outside desk mode: it must reach the real
// auth boundary, not the 409 conflict a desk deployment would answer with.
describe("admin maintenance expire-holds route in online mode", () => {
  it("does not desk-gate: reaches auth and answers the normal unauthenticated status", async () => {
    const { POST } = await import("@/app/api/admin/maintenance/expire-holds/route");
    const res = await POST(
      new Request("http://localhost:3000/api/admin/maintenance/expire-holds", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000", "user-agent": "t" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).not.toBe(409); // never the desk-mode conflict
    expect(res.status).toBe(401); // requireAdmin sees no session
  });
});
