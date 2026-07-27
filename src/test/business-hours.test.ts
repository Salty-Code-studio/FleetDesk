import { describe, it, expect } from "vitest";
import { validateDates } from "@/lib/booking/availability";
import { atAruba } from "@/lib/time/format";

const settings = { minRentalDays: 1, maxRentalDays: 90, maxAdvanceDays: 365, turnaroundBufferHours: 24, openingTime: "08:00", closingTime: "18:00" };
const now = atAruba("2026-08-01", "10:00");

describe("business hours", () => {
  it("accepts times inside opening hours on 30-minute steps", () => {
    expect(() => validateDates(atAruba("2026-08-02", "08:00"), atAruba("2026-08-03", "17:30"), settings, now)).not.toThrow();
  });
  it("rejects a pickup before opening", () => {
    expect(() => validateDates(atAruba("2026-08-02", "07:30"), atAruba("2026-08-03", "10:00"), settings, now)).toThrow(/between 08:00 and 18:00/);
  });
  it("rejects a return after closing", () => {
    expect(() => validateDates(atAruba("2026-08-02", "09:00"), atAruba("2026-08-03", "18:30"), settings, now)).toThrow(/between 08:00 and 18:00/);
  });
  it("rejects off-step minutes", () => {
    expect(() => validateDates(atAruba("2026-08-02", "09:10"), atAruba("2026-08-03", "10:00"), settings, now)).toThrow(/30 minute/);
  });
});
