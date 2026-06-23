import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import {
  createVehicle, updateVehicle, retireVehicle, getVehicle, listVehicles,
  createBlock, listBlocks, deleteBlock, VehicleCreateSchema,
} from "@/lib/admin/vehicles";
import { expectReject } from "./util";

const base = {
  class: "SUV" as const, name: "Test Wagon", seats: 5, transmission: "Automatic" as const,
  doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000,
};
let plateSeq = 1000;
const nextPlate = () => "AV-" + plateSeq++;

beforeAll(async () => { await runMigrations(); });

describe("admin vehicles", () => {
  it("creates a vehicle with parsed defaults", async () => {
    const input = VehicleCreateSchema.parse({ ...base, plate: nextPlate(), slug: "test-wagon" });
    const v = await createVehicle(input);
    expect(v.slug).toBe("test-wagon");
    expect(v.status).toBe("active");
    expect(v.photos).toEqual([]);
    expect(v.depositCents).toBeNull();
  });

  it("rejects a duplicate slug with a conflict", async () => {
    const input = VehicleCreateSchema.parse({ ...base, plate: nextPlate(), slug: "dupe-slug" });
    await createVehicle(input);
    await expectReject(createVehicle(input), /already exists/i);
  });

  it("validates the slug shape and class enum", () => {
    expect(VehicleCreateSchema.safeParse({ ...base, plate: nextPlate(), slug: "Not Kebab" }).success).toBe(false);
    expect(VehicleCreateSchema.safeParse({ ...base, plate: nextPlate(), slug: "ok", class: "Limo" }).success).toBe(false);
  });

  it("patches rates and deposit", async () => {
    const v = await createVehicle(VehicleCreateSchema.parse({ ...base, plate: nextPlate(), slug: "patch-me" }));
    const updated = await updateVehicle(v.id, { priceDayCents: 6000, depositCents: 20000 });
    expect(updated.priceDayCents).toBe(6000);
    expect(updated.depositCents).toBe(20000);
    expect(updated.name).toBe("Test Wagon");
  });

  it("retires instead of deleting, preserving the row", async () => {
    const v = await createVehicle(VehicleCreateSchema.parse({ ...base, plate: nextPlate(), slug: "retire-me" }));
    const retired = await retireVehicle(v.id);
    expect(retired.status).toBe("retired");
    expect(await getVehicle(v.id)).toBeDefined(); // still there for history
    expect((await listVehicles()).some((x) => x.id === v.id)).toBe(true);
  });

  it("manages availability blocks per vehicle", async () => {
    const v = await createVehicle(VehicleCreateSchema.parse({ ...base, plate: nextPlate(), slug: "blocked-car" }));
    const b = await createBlock(v.id, { startDate: "2026-09-01", endDate: "2026-09-05", reason: "Service" });
    expect((await listBlocks(v.id)).length).toBe(1);
    expect(await deleteBlock(b.id)).toBe(true);
    expect((await listBlocks(v.id)).length).toBe(0);
  });
});
