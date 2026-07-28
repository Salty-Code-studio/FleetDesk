import { describe, it, expect } from "vitest";
import { parseDollarsToCents, centsToDollarsString, centsToDisplayString } from "@/components/ui/MoneyInput";

/**
 * Regression coverage for the admin money-input bug: an
 * `<input type="number">` fed straight through
 * `Math.round(Number(e.target.value) * 100)` on every keystroke resets to 0
 * the instant a user types a decimal point, because the browser's number
 * input reports `.value === ""` for the interim (not-yet-valid) string
 * "45." -- and `Number("") * 100` is 0.
 *
 * MoneyInput fixes this by keeping the raw typed string and only committing
 * a cents value when `parseDollarsToCents` can actually parse it, otherwise
 * holding the last-committed value. This test drives the exact keystroke
 * sequence a user typing "45.50" produces and asserts the running
 * committed-cents value never collapses to 0 along the way.
 */
describe("MoneyInput money parsing", () => {
  it("never resets the committed cents to 0 while typing a decimal, and lands on the right value", () => {
    let committed = 0;

    function type(raw: string): number {
      const parsed = parseDollarsToCents(raw);
      if (parsed !== null) committed = parsed;
      return committed;
    }

    expect(type("4")).toBe(400);
    expect(type("45")).toBe(4500);
    // The exact repro from the bug report: typing the decimal point.
    expect(type("45.")).toBe(4500); // <- must NOT be 0
    expect(type("45.5")).toBe(4550);
    expect(type("45.50")).toBe(4550); // trailing zero, still 4550
  });

  it("does not reset to 0 for the young-driver-fee/minimum-deposit repro: '45.' then '5' yields 4550", () => {
    let committed = 0;
    const type = (raw: string) => {
      const parsed = parseDollarsToCents(raw);
      if (parsed !== null) committed = parsed;
      return committed;
    };

    type("45.");
    expect(committed).not.toBe(0);
    type("45.5");
    expect(committed).toBe(4550);
  });

  it("treats empty and bare '.' as not-yet-committable", () => {
    expect(parseDollarsToCents("")).toBeNull();
    expect(parseDollarsToCents(".")).toBeNull();
    expect(parseDollarsToCents("  ")).toBeNull();
  });

  it("rejects garbage and multi-dot strings without throwing", () => {
    expect(parseDollarsToCents("abc")).toBeNull();
    expect(parseDollarsToCents("4.5.6")).toBeNull();
    expect(parseDollarsToCents("-5")).toBeNull();
  });

  it("round-trips cents through the dollars-string formatter", () => {
    expect(centsToDollarsString(4550)).toBe("45.5");
    expect(centsToDollarsString(0)).toBe("0");
    expect(parseDollarsToCents(centsToDollarsString(4550))).toBe(4550);
  });

  /**
   * Add-on price, insurance-tier daily price, fleet day/week/month price,
   * fleet deposit, refund amount, and the dashboard quick-add price all
   * adopted MoneyInput with a nullable `cents` prop so a blank "new record"
   * form can start genuinely empty (matching their pre-existing `required`
   * + blank-default semantics) instead of pre-filling "0" -- which would
   * both defeat the `required` guard and let a distracted save silently
   * persist priceCents/amountCents = 0.
   */
  it("displays a blank field for unset (null) cents rather than '0'", () => {
    expect(centsToDisplayString(null)).toBe("");
    expect(centsToDisplayString(0)).toBe("0");
    expect(centsToDisplayString(4550)).toBe("45.5");
  });

  it("does not reset an in-progress new-record price entry to 0 or null on a decimal point", () => {
    let committed: number | null = null;
    const type = (raw: string) => {
      const parsed = parseDollarsToCents(raw);
      if (parsed !== null) committed = parsed;
      return committed;
    };

    expect(type("4")).toBe(400);
    expect(type("45")).toBe(4500);
    expect(type("45.")).toBe(4500); // <- must NOT reset to 0 or null
    expect(type("45.5")).toBe(4550);
    expect(committed).toBe(4550);
  });
});
