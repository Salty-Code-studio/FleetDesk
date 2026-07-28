import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { createVehicle, updateVehicle, VehicleCreateSchema } from "@/lib/admin/vehicles";

const base = {
  class: "Compact" as const, name: "Kia Picanto", seats: 5, transmission: "Automatic" as const,
  doors: 4, priceDayCents: 4500, priceWeekCents: 27000, priceMonthCents: 99000,
};
let plateSeq = 7000;
const nextPlate = () => "ID-" + plateSeq++;

beforeAll(async () => { await runMigrations(); });

describe("vehicle identity fields (make, model, year, color)", () => {
  it("accepts and persists make, model, year and color", async () => {
    const input = VehicleCreateSchema.parse({
      ...base, plate: nextPlate(), slug: "identity-full",
      make: "Kia", model: "Picanto", year: 2023, color: "White",
    });
    const v = await createVehicle(input);
    expect(v.make).toBe("Kia");
    expect(v.model).toBe("Picanto");
    expect(v.year).toBe(2023);
    expect(v.color).toBe("White");
  });

  it("defaults all identity fields to null when omitted", async () => {
    const v = await createVehicle(VehicleCreateSchema.parse({ ...base, plate: nextPlate(), slug: "identity-none" }));
    expect(v.make).toBeNull();
    expect(v.model).toBeNull();
    expect(v.year).toBeNull();
    expect(v.color).toBeNull();
  });

  it("patches identity fields and allows clearing with null", async () => {
    const v = await createVehicle(VehicleCreateSchema.parse({
      ...base, plate: nextPlate(), slug: "identity-patch", make: "Suzuki", model: "Jimny", year: 2019, color: "Green",
    }));
    const updated = await updateVehicle(v.id, { model: "Jimny Sierra", color: null });
    expect(updated.make).toBe("Suzuki");
    expect(updated.model).toBe("Jimny Sierra");
    expect(updated.color).toBeNull();
  });

  it("rejects a non-integer or out-of-range year and an empty make", () => {
    expect(VehicleCreateSchema.safeParse({ ...base, plate: nextPlate(), slug: "y1", year: 2023.5 }).success).toBe(false);
    expect(VehicleCreateSchema.safeParse({ ...base, plate: nextPlate(), slug: "y2", year: 1899 }).success).toBe(false);
    expect(VehicleCreateSchema.safeParse({ ...base, plate: nextPlate(), slug: "y3", make: "   " }).success).toBe(false);
  });
});
