import { describe, it, expect } from "vitest";
import { complianceBadges, rateLine, sortForCards } from "@/lib/admin/fleet-card";

const TODAY = "2026-10-21";

describe("complianceBadges", () => {
  it("shows an insurance badge exactly at the alert window and hides it one day beyond", () => {
    const atEdge = complianceBadges({ insuranceExpiresOn: "2026-11-20", inspectionDueOn: null }, TODAY, 30);
    expect(atEdge).toEqual([{ key: "Insurance", label: "Insurance 30d", overdue: false }]);
    const beyond = complianceBadges({ insuranceExpiresOn: "2026-11-21", inspectionDueOn: null }, TODAY, 30);
    expect(beyond).toEqual([]);
  });
  it("labels a past due date as overdue", () => {
    const out = complianceBadges({ insuranceExpiresOn: null, inspectionDueOn: "2026-10-18" }, TODAY, 30);
    expect(out).toEqual([{ key: "Inspection", label: "Inspection overdue", overdue: true }]);
  });
  it("counts days from the Aruba today string, not the server clock", () => {
    const out = complianceBadges({ insuranceExpiresOn: "2026-10-26", inspectionDueOn: "2026-10-26" }, TODAY, 30);
    expect(out.map((b) => b.label)).toEqual(["Insurance 5d", "Inspection 5d"]);
  });
  it("gives no badges when both dates are null", () => {
    expect(complianceBadges({ insuranceExpiresOn: null, inspectionDueOn: null }, TODAY, 30)).toEqual([]);
  });
});

describe("rateLine", () => {
  it("formats day, week and month rates in whole units", () => {
    expect(rateLine({ priceDayCents: 4500, priceWeekCents: 28000, priceMonthCents: 99000 }, "$"))
      .toBe("$45 day · $280 week · $990 month");
  });
});

describe("sortForCards", () => {
  const car = (plate: string, cls: string, status = "active") => ({ plate, class: cls, status });
  it("puts retired cars after active cars of an earlier class", () => {
    const sorted = sortForCards(
      [car("R-1", "Economy", "retired"), car("S-1", "SUV"), car("E-2", "Economy")],
      ["Economy", "Compact", "SUV", "4x4", "Van"],
    );
    expect(sorted.map((c) => c.plate)).toEqual(["E-2", "S-1", "R-1"]);
  });
  it("orders by class order, then plate", () => {
    const sorted = sortForCards(
      [car("B", "Van"), car("A", "Van"), car("Z", "Compact")],
      ["Economy", "Compact", "SUV", "4x4", "Van"],
    );
    expect(sorted.map((c) => c.plate)).toEqual(["Z", "A", "B"]);
  });
});
