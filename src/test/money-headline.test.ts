import { describe, it, expect } from "vitest";
import { moneyHeadline } from "@/lib/admin/money-headline";

const months = (...c: number[]) => c.map((cents, i) => ({ month: `2026-0${i + 1}`, cents }));

describe("moneyHeadline", () => {
  it("says up when this month beats last", () => {
    const h = moneyHeadline(months(10000, 11200), "2026-02");
    expect(h).toEqual({ thisMonthCents: 11200, lastMonthCents: 10000, deltaPct: 12, line: "Up 12% on last month" });
  });
  it("says down when this month trails last", () => {
    const h = moneyHeadline(months(10000, 9200), "2026-02");
    expect(h.deltaPct).toBe(-8);
    expect(h.line).toBe("Down 8% on last month");
  });
  it("says level at 0%", () => {
    const h = moneyHeadline(months(10000, 10000), "2026-02");
    expect(h.deltaPct).toBe(0);
    expect(h.line).toBe("Level with last month");
  });
  it("says nothing booked when last month is zero", () => {
    const h = moneyHeadline(months(0, 5000), "2026-02");
    expect(h).toEqual({ thisMonthCents: 5000, lastMonthCents: 0, deltaPct: null, line: "Nothing booked last month" });
  });
  it("says nothing booked when there is no previous entry", () => {
    const h = moneyHeadline(months(5000), "2026-01");
    expect(h).toEqual({ thisMonthCents: 5000, lastMonthCents: null, deltaPct: null, line: "Nothing booked last month" });
  });
  it("compares January against the December before it by array order", () => {
    const h = moneyHeadline(
      [{ month: "2025-12", cents: 20000 }, { month: "2026-01", cents: 25000 }],
      "2026-01",
    );
    expect(h.lastMonthCents).toBe(20000);
    expect(h.line).toBe("Up 25% on last month");
  });
  it("treats a missing current month as zero", () => {
    const h = moneyHeadline(months(10000), "2026-02");
    expect(h.thisMonthCents).toBe(0);
  });
});
