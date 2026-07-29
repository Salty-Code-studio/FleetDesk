import { describe, it, expect } from "vitest";
import { hourSpan } from "@/lib/admin/hour-grid";
import { atAruba } from "@/lib/time/format";

const day = "2029-05-10";
const at = (d: string, t: string) => atAruba(d, t);

describe("hourSpan", () => {
  it("places a same-day 09:00→17:00 booking at the right hour offset and width", () => {
    const s = hourSpan(day, at(day, "09:00"), at(day, "17:00"));
    expect(s).not.toBeNull();
    expect(s!.left).toBeCloseTo((9 / 24) * 100, 5);
    expect(s!.width).toBeCloseTo((8 / 24) * 100, 5);
    expect(s!.cutStart).toBe(false);
    expect(s!.cutEnd).toBe(false);
  });

  it("clamps the left edge and flags cutStart for a booking that began before this day", () => {
    const s = hourSpan(day, at("2029-05-08", "09:00"), at(day, "12:00"));
    expect(s!.left).toBeCloseTo(0, 5);
    expect(s!.width).toBeCloseTo((12 / 24) * 100, 5);
    expect(s!.cutStart).toBe(true);
    expect(s!.cutEnd).toBe(false);
  });

  it("clamps the right edge and flags cutEnd for a booking that runs past this day", () => {
    const s = hourSpan(day, at(day, "15:00"), at("2029-05-12", "10:00"));
    expect(s!.left).toBeCloseTo((15 / 24) * 100, 5);
    expect(s!.width).toBeCloseTo(((24 - 15) / 24) * 100, 5);
    expect(s!.cutStart).toBe(false);
    expect(s!.cutEnd).toBe(true);
  });

  it("fills the whole day (both edges cut) for a multi-day rental spanning it entirely", () => {
    const s = hourSpan(day, at("2029-05-08", "09:00"), at("2029-05-12", "10:00"));
    expect(s!.left).toBeCloseTo(0, 5);
    expect(s!.width).toBeCloseTo(100, 5);
    expect(s!.cutStart).toBe(true);
    expect(s!.cutEnd).toBe(true);
  });

  it("returns null for a booking that does not touch this day", () => {
    expect(hourSpan(day, at("2029-05-01", "09:00"), at("2029-05-02", "17:00"))).toBeNull();
  });

  it("returns null when a booking ends exactly at this day's 00:00 (no overlap)", () => {
    expect(hourSpan(day, at("2029-05-08", "09:00"), at(day, "00:00"))).toBeNull();
  });
});
