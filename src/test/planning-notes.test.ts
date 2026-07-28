import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { adminUsers } from "@/lib/db/schema";
import { createVehicle, VehicleCreateSchema } from "@/lib/admin/vehicles";
import { createNote, setNoteResolved } from "@/lib/admin/vehicle-notes";
import { getPlanning } from "@/lib/admin/planning";

const base = {
  class: "Van" as const, name: "Badge Van", seats: 9, transmission: "Manual" as const,
  doors: 4, priceDayCents: 9000, priceWeekCents: 54000, priceMonthCents: 180000,
};
let seq = 9100;

let adminId: string;

beforeAll(async () => {
  const db = await getDb();
  await runMigrations();
  const [a] = await db.insert(adminUsers).values({
    email: "planning-notes@fleetdesk.app",
    passwordHash: "$argon2id$placeholder-hash-not-a-real-credential",
  }).returning();
  adminId = a!.id;
});

describe("planning board open-note counts", () => {
  it("carries openNotes per vehicle, counting only unresolved notes", async () => {
    const noisy = await createVehicle(VehicleCreateSchema.parse({ ...base, plate: "PN-" + seq++, slug: "planning-noisy" }));
    const quiet = await createVehicle(VehicleCreateSchema.parse({ ...base, plate: "PN-" + seq++, slug: "planning-quiet" }));
    await createNote(noisy.id, { body: "AC blows warm" }, adminId);
    await createNote(noisy.id, { body: "Scratch on left door" }, adminId);
    const done = await createNote(noisy.id, { body: "Oil change due" }, adminId);
    await setNoteResolved(done.id, true);

    const planning = await getPlanning("2026-08-01", "2026-08-14");
    const flat = planning.categories.flatMap((c) => c.vehicles);
    expect(flat.find((v) => v.id === noisy.id)?.openNotes).toBe(2);
    expect(flat.find((v) => v.id === quiet.id)?.openNotes).toBe(0);
  });
});
