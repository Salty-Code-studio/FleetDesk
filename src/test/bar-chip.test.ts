import { describe, it, expect } from "vitest";
import { chipFor } from "@/lib/admin/bar-chip";

describe("chipFor", () => {
  it("maps each bar state to a short label and a tone", () => {
    expect(chipFor("pending", false, false)).toEqual({ label: "pending", tone: "pending" });
    expect(chipFor("confirmed", false, false)).toEqual({ label: "booked", tone: "confirmed" });
    expect(chipFor("picked_up", false, false)).toEqual({ label: "out", tone: "out" });
    expect(chipFor("due_back_soon", false, false)).toEqual({ label: "due", tone: "due" });
    expect(chipFor("overdue", false, false)).toEqual({ label: "late", tone: "late" });
    expect(chipFor("completed", false, false)).toEqual({ label: "back", tone: "done" });
  });
  it("unpaid wins over any state that can owe money", () => {
    expect(chipFor("picked_up", true, false)).toEqual({ label: "unpaid", tone: "unpaid" });
    expect(chipFor("completed", true, false)).toEqual({ label: "unpaid", tone: "unpaid" });
    expect(chipFor("overdue", true, false)).toEqual({ label: "unpaid", tone: "unpaid" });
  });
  it("a manual booking keeps its state but the label says desk", () => {
    expect(chipFor("confirmed", false, true)).toEqual({ label: "booked ✦", tone: "confirmed" });
  });
  it("cancelled never reaches the board but still maps safely", () => {
    expect(chipFor("cancelled", false, false)).toEqual({ label: "cancelled", tone: "done" });
  });
});
