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

  it("applies a partial update", async () => {
    const updated = await patchSettings({ reservationFeeCents: 3500, minDriverAge: 23 });
    expect(updated.reservationFeeCents).toBe(3500);
    expect(updated.minDriverAge).toBe(23);
    expect(updated.currency).toBe("USD"); // untouched
  });

  it("validates ranges and the min≤max invariant", () => {
    expect(SettingsPatchSchema.safeParse({ minDriverAge: 12 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ reservationFeeCents: -5 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ minRentalDays: 10, maxRentalDays: 3 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ currency: "US" }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ adminAlertRecipients: ["a@b.com"] }).success).toBe(true);
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
