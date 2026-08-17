import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { approvalRequests, bookings, customers, vehicles } from "@/lib/db/schema";
import { getSettings, patchSettings } from "@/lib/admin/settings";

beforeAll(async () => { await runMigrations(); });

describe("approval schema", () => {
  it("stores an approval request with defaults", async () => {
    const db = await getDb();
    await db.insert(vehicles).values({
      slug: "apv-car", plate: "APV-1", name: "Apv Car", class: "SUV", status: "active",
      seats: 5, transmission: "Automatic", doors: 5,
      priceDayCents: 9000, priceWeekCents: 50000, priceMonthCents: 150000,
    });
    const [v] = await db.select().from(vehicles);
    await db.insert(customers).values({ email: "apv@example.com", name: "Apv", phone: "" });
    const [c] = await db.select().from(customers);
    const [b] = await db.insert(bookings).values({
      vehicleId: v!.id, customerId: c!.id,
      startAt: "2027-04-01T10:00:00-04:00", endAt: "2027-04-03T10:00:00-04:00",
      bufferEndAt: "2027-04-04T10:00:00-04:00",
      status: "pending", priceBreakdown: {}, paymentOption: "full",
      acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "apv-key-1",
    }).returning();
    const [row] = await db.insert(approvalRequests).values({
      bookingId: b!.id, tokenHash: "h", expiresAt: new Date(Date.now() + 1000),
    }).returning();
    expect(row!.status).toBe("open");
    expect(row!.sentTo).toEqual([]);
    expect(row!.reminderCount).toBe(0);
  });

  it("settings carries approval manager config with defaults", async () => {
    const s = await getSettings();
    expect(s.approvalManagers).toEqual([]);
    expect(s.approvalReminderHours).toBe(4);
    expect(s.approvalMaxReminders).toBe(1);
    const updated = await patchSettings({
      approvalManagers: [{ name: "Naomi", email: "naomi@example.com", inviteCode: "code-1234-abcd" }],
      approvalReminderHours: 6,
    });
    expect(updated.approvalManagers[0]!.name).toBe("Naomi");
    expect(updated.approvalReminderHours).toBe(6);
  });
});
