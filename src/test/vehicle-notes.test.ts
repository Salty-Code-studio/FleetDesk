import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { runMigrations } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { adminUsers, vehicleNotes, availabilityBlocks } from "@/lib/db/schema";
import { createVehicle, VehicleCreateSchema } from "@/lib/admin/vehicles";
import { createNote, listNotes, setNoteResolved, openNoteCounts, NoteCreateSchema, escalateNoteToBlock } from "@/lib/admin/vehicle-notes";
import { arubaToday } from "@/lib/booking/public";
import { expectReject } from "./util";

const base = {
  class: "SUV" as const, name: "Note Wagon", seats: 5, transmission: "Automatic" as const,
  doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000,
};
let seq = 8000;
const nextPlate = () => "VN-" + seq++;
const nextSlug = () => "note-car-" + seq;

let db: Awaited<ReturnType<typeof getDb>>;
let adminId: string;

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [a] = await db.insert(adminUsers).values({
    email: "notes-admin@fleetdesk.app",
    passwordHash: "$argon2id$placeholder-hash-not-a-real-credential",
  }).returning();
  adminId = a!.id;
});

async function makeVehicle() {
  return createVehicle(VehicleCreateSchema.parse({ ...base, plate: nextPlate(), slug: nextSlug() }));
}

describe("vehicle notes", () => {
  it("creates a note against a vehicle with the acting admin recorded", async () => {
    const v = await makeVehicle();
    const n = await createNote(v.id, { body: "  Customer says brakes feel soft  " }, adminId);
    expect(n.vehicleId).toBe(v.id);
    expect(n.body).toBe("Customer says brakes feel soft"); // trimmed at the boundary
    expect(n.createdBy).toBe(adminId);
    expect(n.resolvedAt).toBeNull();
  });

  it("rejects an empty body and an unknown vehicle", async () => {
    expect(NoteCreateSchema.safeParse({ body: "   " }).success).toBe(false);
    await expectReject(createNote("00000000-0000-0000-0000-000000000000", { body: "hello" }, adminId), /not found/i);
  });

  it("lists notes newest first", async () => {
    const v = await makeVehicle();
    await db.insert(vehicleNotes).values({ vehicleId: v.id, body: "older", createdAt: new Date("2026-07-01T12:00:00Z") });
    await db.insert(vehicleNotes).values({ vehicleId: v.id, body: "newer", createdAt: new Date("2026-07-02T12:00:00Z") });
    const notes = await listNotes(v.id);
    expect(notes.map((n) => n.body)).toEqual(["newer", "older"]);
  });

  it("resolves and reopens a note", async () => {
    const v = await makeVehicle();
    const n = await createNote(v.id, { body: "Wiper blade worn" }, adminId);
    const resolved = await setNoteResolved(n.id, true);
    expect(resolved.resolvedAt).not.toBeNull();
    const reopened = await setNoteResolved(n.id, false);
    expect(reopened.resolvedAt).toBeNull();
    await expectReject(setNoteResolved("00000000-0000-0000-0000-000000000000", true), /not found/i);
  });

  it("counts only open notes per vehicle", async () => {
    const a = await makeVehicle();
    const b = await makeVehicle();
    await createNote(a.id, { body: "one" }, adminId);
    await createNote(a.id, { body: "two" }, adminId);
    const done = await createNote(a.id, { body: "three" }, adminId);
    await setNoteResolved(done.id, true);
    const counts = await openNoteCounts();
    expect(counts.get(a.id)).toBe(2);
    expect(counts.get(b.id)).toBeUndefined();
  });
});

describe("escalate note to availability block", () => {
  it("creates a 7 day maintenance block starting today in Aruba; the note stays open", async () => {
    const v = await makeVehicle();
    const n = await createNote(v.id, { body: "Brakes feel soft" }, adminId);
    const { block } = await escalateNoteToBlock(n.id);
    expect(block.vehicleId).toBe(v.id);
    expect(block.type).toBe("maintenance");
    expect(block.reason).toBe("Brakes feel soft");
    const expectedStart = new Date(`${arubaToday()}T00:00:00-04:00`);
    expect(new Date(block.startAt).getTime()).toBe(expectedStart.getTime());
    expect(new Date(block.endAt).getTime() - new Date(block.startAt).getTime()).toBe(7 * 86_400_000);
    // the note stays open so the badge keeps nagging until the work is done
    const counts = await openNoteCounts();
    expect(counts.get(v.id)).toBe(1);
    // and the block is a perfectly normal availability block row
    const rows = await db.select().from(availabilityBlocks).where(eq(availabilityBlocks.vehicleId, v.id));
    expect(rows.length).toBe(1);
  });

  it("rejects an unknown note", async () => {
    await expectReject(escalateNoteToBlock("00000000-0000-0000-0000-000000000000"), /not found/i);
  });
});
