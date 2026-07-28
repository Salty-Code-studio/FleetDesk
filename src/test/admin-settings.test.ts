import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import {
  getSettings, patchSettings, SettingsPatchSchema,
  listBlackouts, createBlackout, deleteBlackout, BlackoutSchema,
} from "@/lib/admin/settings";

beforeAll(async () => { await runMigrations(); });

describe("admin settings", () => {
  it("self-heals and returns the singleton", async () => {
    const s = await getSettings();
    expect(s.id).toBe(1);
    expect(s.currency).toBe("USD");
  });

  it("defaults the young-driver settings and the new minimum age", async () => {
    const s = await getSettings();
    expect(s.minDriverAge).toBe(18);
    expect(s.youngDriverAge).toBe(21);
    expect(s.youngDriverFeeCentsPerDay).toBe(1000);
  });

  it("applies a partial update", async () => {
    const updated = await patchSettings({ depositMinCents: 3500, minDriverAge: 23 });
    expect(updated.depositMinCents).toBe(3500);
    expect(updated.minDriverAge).toBe(23);
    expect(updated.currency).toBe("USD"); // untouched
  });

  it("validates ranges and the min≤max invariant", () => {
    expect(SettingsPatchSchema.safeParse({ minDriverAge: 12 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ depositMinCents: -5 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ depositPercent: 130 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ cancellationWindowHours: -1 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ minRentalDays: 10, maxRentalDays: 3 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ currency: "US" }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ adminAlertRecipients: ["a@b.com"] }).success).toBe(true);
  });

  it("patches the young-driver settings", async () => {
    const updated = await patchSettings({ youngDriverAge: 23, youngDriverFeeCentsPerDay: 1500 });
    expect(updated.youngDriverAge).toBe(23);
    expect(updated.youngDriverFeeCentsPerDay).toBe(1500);
    // restore so later files that share the test database see the defaults
    await patchSettings({ youngDriverAge: 21, youngDriverFeeCentsPerDay: 1000 });
  });

  it("range-checks the young-driver settings", () => {
    expect(SettingsPatchSchema.safeParse({ youngDriverAge: 12 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ youngDriverAge: 120 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ youngDriverFeeCentsPerDay: -1 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ youngDriverAge: 21, youngDriverFeeCentsPerDay: 1000 }).success).toBe(true);
  });

  it("creates, lists, and deletes blackout windows", async () => {
    const b = await createBlackout({ startDate: "2026-12-24", endDate: "2026-12-27", reason: "Holiday" });
    expect((await listBlackouts()).some((x) => x.id === b.id)).toBe(true);
    expect(await deleteBlackout(b.id)).toBe(true);
    expect(await deleteBlackout(b.id)).toBe(false); // already gone
  });

  it("rejects a blackout whose end is not after its start", () => {
    expect(BlackoutSchema.safeParse({ startDate: "2026-12-24", endDate: "2026-12-24" }).success).toBe(false);
  });

  it("rejects a partial patch that would make min>max against the stored value", async () => {
    await patchSettings({ minRentalDays: 1, maxRentalDays: 30 });
    // patch only min, above the stored max — must be rejected (merged check)
    await expect(patchSettings({ minRentalDays: 60 })).rejects.toThrow();
    // stored state unchanged
    expect((await getSettings()).minRentalDays).toBe(1);
  });
});
