import { describe, it, expect } from "vitest";
import { stageFor, STAGES, sheetActions, showNextFor } from "@/lib/admin/booking-stage";

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

describe("sheetActions", () => {
  // Mirrors the server: move-booking.ts allows pending/confirmed only,
  // extend-booking.ts confirmed/picked_up only.
  it("pending can move, swap and cancel, not extend", () => {
    expect(sheetActions("pending")).toEqual({ move: true, extend: false, swap: true, cancel: true });
  });
  it("confirmed can do everything", () => {
    expect(sheetActions("confirmed")).toEqual({ move: true, extend: true, swap: true, cancel: true });
  });
  it("picked up can extend and swap only", () => {
    expect(sheetActions("picked_up")).toEqual({ move: false, extend: true, swap: true, cancel: false });
  });
  it("completed and cancelled offer nothing", () => {
    const none = { move: false, extend: false, swap: false, cancel: false };
    expect(sheetActions("completed")).toEqual(none);
    expect(sheetActions("cancelled")).toEqual(none);
  });
});

describe("showNextFor", () => {
  const pay = { kind: "pay" as const, label: "Take payment" as const, amountCents: 4500 };
  it("Take payment is owner only (the desk-payment route is owner gated)", () => {
    expect(showNextFor(pay, "owner")).toBe(true);
    expect(showNextFor(pay, "staff")).toBe(false);
  });
  it("confirm and link steps show for staff too", () => {
    expect(showNextFor({ kind: "confirm", label: "Confirm booking" }, "staff")).toBe(true);
    expect(showNextFor({ kind: "link", label: "Start handover", href: "/x" }, "staff")).toBe(true);
  });
  it("no next step shows nothing", () => {
    expect(showNextFor(null, "owner")).toBe(false);
  });
});
