import { describe, it, expect } from "vitest";
import { shiftYearsISO, licenceDateBounds } from "@/lib/booking/license-bounds";

describe("shiftYearsISO", () => {
  it("shifts whole years in both directions", () => {
    expect(shiftYearsISO("2026-09-08", 25)).toBe("2051-09-08");
    expect(shiftYearsISO("2026-09-08", -100)).toBe("1926-09-08");
  });

  it("clamps 29 February onto a non-leap target year", () => {
    expect(shiftYearsISO("2024-02-29", 1)).toBe("2025-02-28");
    expect(shiftYearsISO("2024-02-29", -1)).toBe("2023-02-28");
    expect(shiftYearsISO("2024-02-29", 4)).toBe("2028-02-29"); // still a leap year
  });
});

describe("licenceDateBounds", () => {
  const b = licenceDateBounds("2026-09-08");

  it("lets the expiry picker reach 2036 and beyond", () => {
    // The whole point of this task: customers already hold licences valid to
    // 2036, and the old shared window topped out at today + 5 years (2031).
    expect(b.expiryDate.max >= "2036-12-31").toBe(true);
    expect(b.expiryDate.max).toBe("2051-09-08");
  });

  it("never offers a birth or issue date in the future", () => {
    expect(b.dob.max).toBe("2026-09-08");
    expect(b.issueDate.max).toBe("2026-09-08");
  });

  it("reaches far enough back for an old driver and an old licence", () => {
    expect(b.dob.min).toBe("1926-09-08");
    expect(b.issueDate.min).toBe("1976-09-08");
  });

  it("does not let an expiry sit in the past", () => {
    expect(b.expiryDate.min).toBe("2026-09-08");
  });
});
