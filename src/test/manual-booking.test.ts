import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, settings, customers } from "@/lib/db/schema";
import { createManualBooking } from "@/lib/admin/manual-booking";
import { atAruba } from "@/lib/time/format";
import { expectReject } from "./util";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "";
let retiredId = "";

const at = (d: string) => atAruba(d, "09:00");

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
  const [v] = await db.insert(vehicles).values({
    slug: "mb", plate: "MB-1", class: "SUV", name: "MB", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000,
  }).returning();
  vehicleId = v!.id;
  const [r] = await db.insert(vehicles).values({
    slug: "mb-retired", plate: "MB-R", class: "Van", name: "Retired MB", seats: 8, transmission: "Automatic",
    doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1, status: "retired",
  }).returning();
  retiredId = r!.id;
});

describe("manual booking", () => {
  it("creates a confirmed manual booking with a synthetic customer", async () => {
    const b = await createManualBooking({
      vehicleId, startAt: at("2027-02-01"), endAt: at("2027-02-04"),
      customerName: "Walk In", customerPhone: "297111", priceCents: 18000,
    });
    expect(b.status).toBe("confirmed");
    expect(b.source).toBe("manual");
    expect(b.paymentOption).toBe("cash_deposit");
    expect((b.priceBreakdown as { subtotalCents: number }).subtotalCents).toBe(18000);
    const [c] = await db.select().from(customers).where(eq(customers.id, b.customerId));
    expect(c!.email).toMatch(/@fleetdesk\.local$/);
    expect(c!.name).toBe("Walk In");
  });

  it("uses a provided real email instead of a synthetic one", async () => {
    const b = await createManualBooking({
      vehicleId, startAt: at("2027-06-01"), endAt: at("2027-06-03"),
      customerName: "Real Guest", customerEmail: "guest@example.com",
    });
    const [c] = await db.select().from(customers).where(eq(customers.id, b.customerId));
    expect(c!.email).toBe("guest@example.com");
  });

  it("rejects an overlapping manual booking (buffered exclusion constraint)", async () => {
    await createManualBooking({ vehicleId, startAt: at("2027-03-01"), endAt: at("2027-03-05"), customerName: "A", customerPhone: "1" });
    await expectReject(
      createManualBooking({ vehicleId, startAt: at("2027-03-04"), endAt: at("2027-03-08"), customerName: "B", customerPhone: "2" }),
      /no longer|already|overlap|conflict|not available|reservation|taken/i,
    );
  });

  it("rejects a manual booking on a retired vehicle", async () => {
    await expectReject(
      createManualBooking({ vehicleId: retiredId, startAt: at("2027-04-01"), endAt: at("2027-04-03"), customerName: "X" }),
      /not available/i,
    );
  });

  it("allows a near-term booking (soft lead-time guardrail skipped for the desk)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const end = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const b = await createManualBooking({ vehicleId, startAt: at(today), endAt: at(end), customerName: "Now", customerPhone: "9" });
    expect(b.id).toBeDefined();
  });
});
