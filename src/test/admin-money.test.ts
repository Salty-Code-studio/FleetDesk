import { describe, it, expect } from "vitest";
import { centsField, dollarsToCents, centsToDollars } from "@/lib/admin/money";

describe("money helpers", () => {
  it("converts dollars to cents without float drift", () => {
    expect(dollarsToCents(58)).toBe(5800);
    expect(dollarsToCents(0.1)).toBe(10);
    expect(dollarsToCents(19.99)).toBe(1999);
  });

  it("converts cents back to dollars", () => {
    expect(centsToDollars(5800)).toBe(58);
    expect(centsToDollars(1999)).toBe(19.99);
  });

  it("rejects negative and fractional cents", () => {
    expect(centsField.safeParse(-1).success).toBe(false);
    expect(centsField.safeParse(10.5).success).toBe(false);
    expect(centsField.safeParse(5800).success).toBe(true);
  });
});
