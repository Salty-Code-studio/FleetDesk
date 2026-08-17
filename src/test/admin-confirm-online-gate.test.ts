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
