import { describe, it, expect } from "vitest";
import { isFreeCancellation } from "@/lib/booking/cancellation";
import { atAruba } from "@/lib/time/format";

const settings = { cancellationWindowHours: 48 };

describe("isFreeCancellation", () => {
  it("is free strictly before the window opens", () => {
    expect(isFreeCancellation({ startAt: atAruba("2026-08-10", "09:00") }, settings, atAruba("2026-08-08", "08:59"))).toBe(true);
  });
  it("is not free inside the window", () => {
    expect(isFreeCancellation({ startAt: atAruba("2026-08-10", "09:00") }, settings, atAruba("2026-08-08", "09:01"))).toBe(false);
  });
  it("boundary minute counts as inside the window", () => {
    expect(isFreeCancellation({ startAt: atAruba("2026-08-10", "09:00") }, settings, atAruba("2026-08-08", "09:00"))).toBe(false);
  });
});
