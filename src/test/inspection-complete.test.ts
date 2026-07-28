import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, adminUsers, inspections, notifications, policies } from "@/lib/db/schema";
import { upsertInspection, completePickup, completeReturn, REQUIRED_ANGLES } from "@/lib/admin/inspections";
import { putObject, getObject } from "@/lib/storage";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "", adminId = "";
let month = 1;

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function mkBooking(key: string, status: "pending" | "confirmed" | "picked_up") {
  const m = String(month++).padStart(2, "0");
  // startAt/endAt/bufferEndAt are `mode: "string"` timestamptz columns in this
  // schema, so seed them with ISO strings (mirrors inspections.test.ts).
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt: `2027-${m}-01T13:00:00Z`,
    endAt: `2027-${m}-05T13:00:00Z`,
    bufferEndAt: `2027-${m}-06T13:00:00Z`,
    status,
    priceBreakdown: { subtotalCents: 40000, vehicleCents: 40000, insuranceCents: 0, addOns: [], addOnsCents: 0, days: 4, currency: "USD" },
    paymentOption: "deposit", acceptedPolicyVersion: 1, acceptedAt: new Date(),
    idempotencyKey: key,
  }).returning();
  return b!;
}

/** Fill a pickup inspection to completeness (photos, meters, borg, signature). */
async function readyPickup(bookingId: string) {
  const sigKey = `signatures/${bookingId}.png`;
  await putObject(sigKey, new Uint8Array(PNG_1PX), "image/png");
  await upsertInspection(bookingId, "pickup", {
    photos: REQUIRED_ANGLES.map((a) => ({ key: `inspections/${bookingId}/pickup/${a}.jpg`, label: a })),
    odometer: 41250, fuelLevel: 6,
    borgReceivedCents: 25000, borgMethod: "cash",
    licensePhotoKey: `licenses/${bookingId}/x.jpg`, licenseCopyReceived: true,
    rulesSigned: true, agreementSigned: true, acceptedPolicyVersion: 1,
    signatureKey: sigKey,
  }, adminId);
}

async function readyReturn(bookingId: string, damage = false) {
  await upsertInspection(bookingId, "return", {
    photos: REQUIRED_ANGLES.map((a) => ({ key: `inspections/${bookingId}/return/${a}.jpg`, label: a })),
    odometer: 41600, fuelLevel: 6, keysReturned: true,
    damageFlags: damage ? [{ photoKey: `inspections/${bookingId}/return/front.jpg`, note: "new scratch front bumper" }] : [],
    borgReturnedCents: damage ? 15000 : 25000,
    borgWithheldCents: damage ? 10000 : 0,
    borgWithheldReason: damage ? "scratch on the front bumper" : null,
  }, adminId);
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "insp-done-car", plate: "PL-insp-done", class: "SUV", name: "Done Car", seats: 5,
    transmission: "Automatic", doors: 5, priceDayCents: 10000, priceWeekCents: 60000,
    priceMonthCents: 200000, depositCents: 25000,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "insp-done@test.com" }).returning();
  const [a] = await db.insert(adminUsers).values({ email: "insp-done-admin@test.com", passwordHash: "x" }).returning();
  await db.insert(policies).values({ type: "rental_terms", version: 1, body: "Drive nicely.", publishedAt: new Date() });
  vehicleId = v!.id; customerId = c!.id; adminId = a!.id;
});

afterAll(async () => {
  await rm(path.resolve(process.cwd(), ".dev-storage"), { recursive: true, force: true });
});

describe("completePickup", () => {
  it("flips confirmed -> picked_up, stores the contract, and rings the bell", async () => {
    const b = await mkBooking("done-pickup-1", "confirmed");
    await readyPickup(b.id);
    const updated = await completePickup(b.id, { actorId: adminId });
    expect(updated.status).toBe("picked_up");

    const [insp] = await db.select().from(inspections)
      .where(and(eq(inspections.bookingId, b.id), eq(inspections.kind, "pickup")));
    expect(insp!.contractPdfKey).toBe(`contracts/${b.id}.pdf`);
    const pdf = await getObject(`contracts/${b.id}.pdf`);
    expect(Buffer.from(pdf.data.slice(0, 5)).toString("ascii")).toBe("%PDF-");

    const bells = await db.select().from(notifications).where(eq(notifications.bookingId, b.id));
    expect(bells.some((n) => n.type === "booking.picked_up")).toBe(true);
  });

  it("refuses an incomplete inspection (missing angles)", async () => {
    const b = await mkBooking("done-pickup-2", "confirmed");
    await upsertInspection(b.id, "pickup", { odometer: 1, fuelLevel: 4 }, adminId);
    await expect(completePickup(b.id, { actorId: adminId })).rejects.toThrow(/walk-around photos/i);
  });

  it("requires a desk override note for an unpaid (pending) booking, then records it", async () => {
    const b = await mkBooking("done-pickup-3", "pending");
    await readyPickup(b.id);
    await expect(completePickup(b.id, { actorId: adminId })).rejects.toThrow(/override note/i);
    const updated = await completePickup(b.id, { actorId: adminId, overrideNote: "owner said ok, pays cash later" });
    expect(updated.status).toBe("picked_up");
    expect(updated.notes).toContain("owner said ok");
  });

  it("cannot complete twice", async () => {
    const b = await mkBooking("done-pickup-4", "confirmed");
    await readyPickup(b.id);
    await completePickup(b.id, { actorId: adminId });
    await expect(completePickup(b.id, { actorId: adminId })).rejects.toThrow(/cannot move/i);
  });
});

describe("completeReturn", () => {
  it("flips picked_up -> completed and rings a WARNING bell on damage", async () => {
    const b = await mkBooking("done-return-1", "confirmed");
    await readyPickup(b.id);
    await completePickup(b.id, { actorId: adminId });
    await readyReturn(b.id, true);
    const updated = await completeReturn(b.id, { actorId: adminId });
    expect(updated.status).toBe("completed");
    const bells = await db.select().from(notifications).where(eq(notifications.bookingId, b.id));
    const returned = bells.find((n) => n.type === "booking.returned");
    expect(returned?.level).toBe("warning");
  });

  it("only a picked_up booking can be returned", async () => {
    const b = await mkBooking("done-return-2", "confirmed");
    await expect(completeReturn(b.id, { actorId: adminId })).rejects.toThrow(/cannot move/i);
  });

  it("borg math must add up and withholding needs a reason", async () => {
    const b = await mkBooking("done-return-3", "confirmed");
    await readyPickup(b.id);
    await completePickup(b.id, { actorId: adminId });
    await upsertInspection(b.id, "return", {
      photos: REQUIRED_ANGLES.map((a) => ({ key: `inspections/${b.id}/return/${a}.jpg`, label: a })),
      odometer: 41600, fuelLevel: 6, keysReturned: true,
      borgReturnedCents: 10000, borgWithheldCents: 10000, // received was 25000
    }, adminId);
    await expect(completeReturn(b.id, { actorId: adminId })).rejects.toThrow(/add up/i);
    await upsertInspection(b.id, "return", { borgReturnedCents: 15000, borgWithheldCents: 10000 }, adminId);
    await expect(completeReturn(b.id, { actorId: adminId })).rejects.toThrow(/reason/i);
    await upsertInspection(b.id, "return", { borgWithheldReason: "missing hubcap" }, adminId);
    const updated = await completeReturn(b.id, { actorId: adminId });
    expect(updated.status).toBe("completed");
  });
});
