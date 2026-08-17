process.env.PAYMENT_MODE = "desk";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

import { describe, it, expect, beforeAll, vi } from "vitest";

// DESK-MODE side of the UI-facing config + admin-confirm gate. The
// online-mode side (the route must 404 outside desk mode) lives in
// admin-confirm-online-gate.test.ts, which runs without PAYMENT_MODE set.

// requireAdmin reads cookies via next/headers, which throws outside a live
// Next request scope; an EMPTY jar stands in (same stand-in as
// upload-body-cap.test.ts, minus the entries) so the admin guard sees
// "no session" instead of crashing.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

beforeAll(async () => {
  const { runMigrations } = await import("@/lib/db/migrate");
  await runMigrations();
});

describe("desk mode surfaces", () => {
  it("booking-config tells the wizard it is desk mode", async () => {
    const { GET } = await import("@/app/api/booking-config/route");
    const res = await GET(new Request("http://localhost:3000/api/booking-config", { headers: { "user-agent": "t" } }), { params: Promise.resolve({}) });
    expect((await res.json()).paymentMode).toBe("desk");
  });

  it("admin confirm route is open for business in desk mode (reaches auth, not the 404 gate)", async () => {
    const { POST } = await import("@/app/api/admin/bookings/[id]/confirm/route");
    const res = await POST(
      new Request("http://localhost:3000/api/admin/bookings/x/confirm", {
        method: "POST",
        headers: { "user-agent": "t" },
      }),
      { params: Promise.resolve({ id: crypto.randomUUID() }) },
    );
    // No session on the request: the desk gate must let it THROUGH to the
    // admin guard's auth failure, never answer the online-mode 404. Proves
    // the gate discriminates on mode, not on everything.
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });
});
