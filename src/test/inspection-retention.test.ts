import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, adminUsers, inspections } from "@/lib/db/schema";
import { upsertInspection, sweepInspectionMedia } from "@/lib/admin/inspections";
import { putObject, getObject } from "@/lib/storage";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "", adminId = "";
let month = 1;

const DAY = 86_400_000;

async function mkCompleted(key: string, endDaysAgo: number) {
  const m = String(month++).padStart(2, "0");
  const end = new Date(Date.now() - endDaysAgo * DAY);
  // startAt/endAt/bufferEndAt are `mode: "string"` timestamptz columns in this
  // schema, so seed them with ISO strings (mirrors inspection-complete.test.ts).
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt: new Date(end.getTime() - 4 * DAY).toISOString(),
    endAt: end.toISOString(),
    bufferEndAt: new Date(end.getTime() + DAY).toISOString(),
    status: "completed",
    priceBreakdown: { subtotalCents: 40000, currency: "USD" },
    paymentOption: "deposit", acceptedPolicyVersion: 1, acceptedAt: new Date(),
    idempotencyKey: `${key}-${m}`,
  }).returning();
  return b!;
}

async function seedMedia(bookingId: string) {
  const photoKey = `inspections/${bookingId}/pickup/front.jpg`;
  const licKey = `licenses/${bookingId}/a.jpg`;
  const sigKey = `signatures/${bookingId}.png`;
  const pdfKey = `contracts/${bookingId}.pdf`;
  for (const k of [photoKey, licKey, sigKey, pdfKey]) {
    await putObject(k, new Uint8Array([1, 2, 3]), "application/octet-stream");
  }
  await upsertInspection(bookingId, "pickup", {
    photos: [{ key: photoKey, label: "front" }],
    licensePhotoKey: licKey,
    signatureKey: sigKey,
    damageFlags: [{ photoKey, note: "old scratch" }],
  }, adminId);
  await db.update(inspections).set({ contractPdfKey: pdfKey })
    .where(and(eq(inspections.bookingId, bookingId), eq(inspections.kind, "pickup")));
  return { photoKey, licKey, sigKey, pdfKey };
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "sweep-car", plate: "PL-sweep", class: "SUV", name: "Sweep Car", seats: 5,
    transmission: "Automatic", doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "sweep@test.com" }).returning();
  const [a] = await db.insert(adminUsers).values({ email: "sweep-admin@test.com", passwordHash: "x" }).returning();
  vehicleId = v!.id; customerId = c!.id; adminId = a!.id;
});

afterAll(async () => {
  await rm(path.resolve(process.cwd(), ".dev-storage"), { recursive: true, force: true });
});

describe("sweepInspectionMedia", () => {
  it("purges media past licenseRetentionDays (default 90) but KEEPS the contract", async () => {
    const b = await mkCompleted("sweep-old", 200);
    const { photoKey, licKey, sigKey, pdfKey } = await seedMedia(b.id);

    const purged = await sweepInspectionMedia();
    expect(purged).toBeGreaterThanOrEqual(1);

    const [insp] = await db.select().from(inspections).where(eq(inspections.bookingId, b.id));
    expect(insp!.photos).toEqual([]);
    expect(insp!.licensePhotoKey).toBeNull();
    expect(insp!.signatureKey).toBeNull();
    expect(insp!.contractPdfKey).toBe(pdfKey);
    expect(insp!.damageFlags).toEqual([{ photoKey: "", note: "old scratch" }]); // notes survive

    await expect(getObject(photoKey)).rejects.toThrow();
    await expect(getObject(licKey)).rejects.toThrow();
    await expect(getObject(sigKey)).rejects.toThrow();
    await expect(getObject(pdfKey)).resolves.toBeTruthy(); // contract stays
  });

  it("leaves recent completed bookings alone and is idempotent", async () => {
    const recent = await mkCompleted("sweep-recent", 5);
    const { photoKey } = await seedMedia(recent.id);

    const first = await sweepInspectionMedia();
    const [insp] = await db.select().from(inspections).where(eq(inspections.bookingId, recent.id));
    expect(insp!.photos).toHaveLength(1);
    await expect(getObject(photoKey)).resolves.toBeTruthy();

    const second = await sweepInspectionMedia();
    expect(second).toBeLessThanOrEqual(first); // nothing new to purge on the second run
  });
});
