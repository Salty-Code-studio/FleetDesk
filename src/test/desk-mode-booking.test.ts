process.env.PAYMENT_MODE = "desk";
process.env.CRON_SECRET = "cron-secret-for-tests"; // BEFORE imports: env freezes at first import
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

import { describe, it, expect, beforeAll } from "vitest";

/** Desk mode: the site feeds the back office with NO payment provider at all.
 *  Bookings land pending, checkout is off, and the unpaid-hold expiry cron
 *  must NOT eat desk bookings (they never get a payment row). */

let bookingId = "";

beforeAll(async () => {
  const { runMigrations } = await import("@/lib/db/migrate");
  await runMigrations();
  const { getDb } = await import("@/lib/db/client");
  const { vehicles } = await import("@/lib/db/schema");
  const db = await getDb();
  await db.insert(vehicles).values({
    slug: "desk-car", plate: "DESK-1", class: "Economy", name: "Desk Car",
    seats: 5, transmission: "Automatic", doors: 5,
    priceDayCents: 5000, priceWeekCents: 30000, priceMonthCents: 100000, status: "active",
  });
});

function bookingInput(key: string) {
  return {
    vehicleSlug: "desk-car",
    // A few months out (well inside the default 365-day maxAdvanceDays), on
    // the hour, inside the default 08:00-18:00 Aruba opening hours.
    startAt: "2026-11-02T10:00:00-04:00",
    endAt: "2026-11-06T10:00:00-04:00",
    customer: { email: "guest@example.com", name: "Guest One", phone: "+599 785 0000" },
    addOns: [], insuranceTierId: null,
    license: {
      nameOnLicense: "Guest One",
      licenseNumber: "L1234567",
      issuingCountry: "NL",
      issueDate: "2020-01-01",
      expiryDate: "2030-01-01",
      dob: "1990-05-05",
    },
    acceptTerms: true as const,
    paymentOption: "full" as const,
    youngDriver: false,
    idempotencyKey: key,
  };
}

describe("desk mode booking flow", () => {
  it("creates a pending booking without any Stripe involvement", async () => {
    const { createBooking } = await import("@/lib/booking/create");
    const { arubaNowIso } = await import("@/lib/booking/public");
    const res = await createBooking(bookingInput("desk-key-1"), arubaNowIso());
    bookingId = res.booking.id;
    expect(res.booking.status).toBe("pending");
  });

  it("refuses the Stripe checkout route", async () => {
    const { POST } = await import("@/app/api/bookings/[id]/checkout/route");
    const req = new Request("http://localhost:3000/api/bookings/x/checkout", {
      method: "POST", headers: { origin: "http://localhost:3000", "user-agent": "t" },
    });
    const res = await POST(req, { params: Promise.resolve({ id: bookingId }) });
    expect(res.status).toBe(409);
  });

  it("refuses the Stripe webhook route without touching bookings", async () => {
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(new Request("http://localhost:3000/api/webhooks/stripe", {
      method: "POST",
      headers: { "user-agent": "t" },
      body: JSON.stringify({ id: "evt_desk_1", type: "checkout.session.completed" }),
    }));
    // The desk-mode guard answers 404 before any signature or event work runs.
    expect(res.status).toBe(404);
    // Nothing downstream ran: the booking from the first test is untouched.
    const { getDb } = await import("@/lib/db/client");
    const { bookings } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const [row] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(row!.status).toBe("pending");
  });

  it("expire-holds cron does not cancel desk bookings", async () => {
    const { GET } = await import("@/app/api/cron/expire-holds/route");
    // Backdate the booking far beyond the 30-minute unpaid-hold TTL.
    const { getDb } = await import("@/lib/db/client");
    const { bookings } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    await db.update(bookings).set({ createdAt: new Date(Date.now() - 3 * 3600_000) }).where(eq(bookings.id, bookingId));
    const res = await GET(new Request("http://localhost:3000/api/cron/expire-holds", {
      headers: { authorization: "Bearer cron-secret-for-tests" },
    }));
    expect(res.status).toBe(200);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(row!.status).toBe("pending"); // NOT cancelled
  });

  it("public booking config announces the mode", async () => {
    const { publicBookingConfig } = await import("@/lib/booking/public");
    const cfg = await publicBookingConfig();
    expect(cfg.paymentMode).toBe("desk");
  });

  it("admin maintenance expire-holds route refuses to run in desk mode", async () => {
    // The gate fires before parseJsonBody and before auth, so no session and
    // no body are needed to prove it: a bare POST must already be refused.
    const { POST } = await import("@/app/api/admin/maintenance/expire-holds/route");
    const res = await POST(
      new Request("http://localhost:3000/api/admin/maintenance/expire-holds", {
        method: "POST",
        headers: { "user-agent": "t" },
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(409);
    // The booking from the first test is untouched: nothing ran.
    const { getDb } = await import("@/lib/db/client");
    const { bookings } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const [row] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(row!.status).toBe("pending");
  });
});
