import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import {
  createAddOn, updateAddOn, deleteAddOn, listAddOns, AddOnCreateSchema,
  createInsurance, updateInsurance, listInsurance, InsuranceCreateSchema,
} from "@/lib/admin/catalog";

beforeAll(async () => { await runMigrations(); });

describe("admin add-ons", () => {
  it("creates, updates, lists, deletes; allows null (unlimited) stock", async () => {
    const a = await createAddOn(AddOnCreateSchema.parse({ name: "Roof box", priceCents: 1200, pricing: "per_rental" }));
    expect(a.stock).toBeNull();
    const u = await updateAddOn(a.id, { stock: 4, active: false });
    expect(u.stock).toBe(4);
    expect(u.active).toBe(false);
    expect((await listAddOns()).some((x) => x.id === a.id)).toBe(true);
    expect(await deleteAddOn(a.id)).toBe(true);
  });

  it("validates pricing enum", () => {
    expect(AddOnCreateSchema.safeParse({ name: "x", priceCents: 1, pricing: "hourly" }).success).toBe(false);
  });

  it("rejects an empty patch instead of crashing on .set({})", async () => {
    const { AddOnPatchSchema } = await import("@/lib/admin/catalog");
    const { InsurancePatchSchema } = await import("@/lib/admin/catalog");
    expect(AddOnPatchSchema.safeParse({}).success).toBe(false);
    expect(InsurancePatchSchema.safeParse({}).success).toBe(false);
    expect(AddOnPatchSchema.safeParse({ active: false }).success).toBe(true);
  });
});

describe("admin insurance tiers", () => {
  it("keeps a single default tier", async () => {
    const basic = await createInsurance(InsuranceCreateSchema.parse({ name: "Basic A", dailyPriceCents: 0, isDefault: true }));
    const premium = await createInsurance(InsuranceCreateSchema.parse({ name: "Premium A", dailyPriceCents: 1500, isDefault: true }));
    const tiers = await listInsurance();
    const defaults = tiers.filter((t) => t.isDefault);
    expect(defaults.length).toBe(1);
    expect(defaults[0]!.id).toBe(premium.id);

    // promoting basic via update flips premium off
    await updateInsurance(basic.id, { isDefault: true });
    const after = (await listInsurance()).filter((t) => t.isDefault);
    expect(after.length).toBe(1);
    expect(after[0]!.id).toBe(basic.id);
  });
});
