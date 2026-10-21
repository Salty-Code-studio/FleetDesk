import { describe, it, expect } from "vitest";
import { stageFor, STAGES } from "@/lib/admin/booking-stage";

const base = { id: "b1", status: "pending", balanceDueCents: 0, paymentMode: "online" as const };

describe("stageFor", () => {
  it("lists the five stages in order", () => {
    expect(STAGES.map((s) => s.label)).toEqual(["Reserved", "Paid", "Out", "Back", "Closed"]);
  });
  it("pending in desk mode is Reserved with a confirm action", () => {
    expect(stageFor({ ...base, paymentMode: "desk" })).toEqual({
      cancelled: false,
      current: "reserved",
      next: { kind: "confirm", label: "Confirm booking" },
    });
  });
  it("pending online is Reserved with no next action, the webhook confirms", () => {
    expect(stageFor({ ...base, paymentMode: "online" })).toEqual({
      cancelled: false,
      current: "reserved",
      next: null,
    });
  });
  it("confirmed is Paid with Start handover linking to check-in", () => {
    expect(stageFor({ ...base, id: "abc", status: "confirmed" })).toEqual({
      cancelled: false,
      current: "paid",
      next: { kind: "link", label: "Start handover", href: "/admin/inspect/abc/checkin" },
    });
  });
  it("picked_up is Out with Check in return linking to checkout", () => {
    expect(stageFor({ ...base, id: "abc", status: "picked_up" })).toEqual({
      cancelled: false,
      current: "out",
      next: { kind: "link", label: "Check in return", href: "/admin/inspect/abc/checkout" },
    });
  });
  it("completed with a balance owed is Back with Take payment for the full balance", () => {
    expect(stageFor({ ...base, status: "completed", balanceDueCents: 4500 })).toEqual({
      cancelled: false,
      current: "back",
      next: { kind: "pay", label: "Take payment", amountCents: 4500 },
    });
  });
  it("completed with zero balance is Closed with no next action", () => {
    expect(stageFor({ ...base, status: "completed", balanceDueCents: 0 })).toEqual({
      cancelled: false,
      current: "closed",
      next: null,
    });
  });
  it("cancelled has no stage and no next action", () => {
    expect(stageFor({ ...base, status: "cancelled" })).toEqual({
      cancelled: true,
      current: null,
      next: null,
    });
  });
  it("unknown status has no stage and no next action", () => {
    expect(stageFor({ ...base, status: "mystery" })).toEqual({
      cancelled: false,
      current: null,
      next: null,
    });
  });
});
