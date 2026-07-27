import { describe, it, expect } from "vitest";
import { barSpan, barState } from "@/lib/admin/bar-span";
import { atAruba } from "@/lib/time/format";

const days = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]; // 4 visible columns

describe("barSpan", () => {
  it("positions a 09:00 to 09:00 bar fractionally inside the day columns", () => {
    const s = barSpan(days, atAruba("2026-08-01", "12:00"), atAruba("2026-08-03", "12:00"))!;
    // 12:00 = halfway into day 0 of 4 columns -> left 12.5%; two days wide -> 50%
    expect(s.left).toBeCloseTo(12.5, 5);
    expect(s.width).toBeCloseTo(50, 5);
  });
  it("clamps bars that overflow the visible range", () => {
    const s = barSpan(days, atAruba("2026-07-30", "09:00"), atAruba("2026-08-02", "09:00"))!;
    expect(s.left).toBe(0);
    expect(s.width).toBeGreaterThan(0);
  });
  it("returns null for bars fully outside the range", () => {
    expect(barSpan(days, atAruba("2026-09-01", "09:00"), atAruba("2026-09-02", "09:00"))).toBeNull();
  });
});

describe("barState", () => {
  const now = atAruba("2026-08-02", "10:00");
  it("maps statuses through", () => {
    expect(barState({ status: "pending", endAt: atAruba("2026-08-05", "09:00") }, now)).toBe("pending");
    expect(barState({ status: "completed", endAt: atAruba("2026-08-01", "09:00") }, now)).toBe("completed");
  });
  it("flags picked_up due back within 24h as due_back_soon", () => {
    expect(barState({ status: "picked_up", endAt: atAruba("2026-08-03", "09:00") }, now)).toBe("due_back_soon");
  });
  it("flags picked_up past return as overdue", () => {
    expect(barState({ status: "picked_up", endAt: atAruba("2026-08-02", "09:00") }, now)).toBe("overdue");
  });
  it("keeps a comfortable picked_up as picked_up", () => {
    expect(barState({ status: "picked_up", endAt: atAruba("2026-08-04", "09:00") }, now)).toBe("picked_up");
  });
});
