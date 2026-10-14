import { describe, it, expect } from "vitest";
import { buildToday, type TodayBookingInput } from "@/lib/admin/today";
import { atAruba } from "@/lib/time/format";

const day = "2028-03-10";
const now = atAruba(day, "08:00");
const at = (d: string, t: string) => atAruba(d, t);

function booking(over: Partial<TodayBookingInput> & { id: string }): TodayBookingInput {
  return {
    startAt: at(day, "09:00"), endAt: at("2028-03-13", "09:00"), status: "confirmed",
    customerName: "Kim Martinus", customerEmail: "kim@example.com",
    plate: "DEMO-001", vehicleName: "Economy Hatchback",
    unpaid: false, balanceDueCents: 0, paidNote: null,
    ...over,
  };
}

describe("buildToday", () => {
  it("lists a confirmed pickup today as a handover with the check-in link", () => {
    const b = buildToday([booking({ id: "a" })], day, now);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ kind: "handover", time: "09:00", action: "Start handover", href: "/admin/inspect/a/checkin", done: false });
    expect(b.goingOut).toBe(1);
  });

  it("a pending pickup today must be confirmed first and opens the sheet", () => {
    const b = buildToday([booking({ id: "a", status: "pending" })], day, now);
    expect(b.items[0]).toMatchObject({ kind: "handover", action: "Confirm first", href: null });
  });

  it("a picked-up pickup today is a done handover", () => {
    const b = buildToday([booking({ id: "a", status: "picked_up" })], day, now);
    expect(b.items[0]).toMatchObject({ kind: "handover", done: true, action: "Handed over" });
    expect(b.done).toBe(1);
  });

  it("a rental returning today is a return with the check-out link", () => {
    const b = buildToday([booking({ id: "r", status: "picked_up", startAt: at("2028-03-07", "09:00"), endAt: at(day, "16:00") })], day, now);
    expect(b.items[0]).toMatchObject({ kind: "return", time: "16:00", action: "Check in", href: "/admin/inspect/r/checkout", done: false });
    expect(b.comingBack).toBe(1);
  });

  it("a completed rental that returned today is a done return", () => {
    const b = buildToday([booking({ id: "r", status: "completed", startAt: at("2028-03-07", "09:00"), endAt: at(day, "16:00") })], day, now);
    expect(b.items[0]).toMatchObject({ kind: "return", done: true, action: "Back" });
  });

  it("a same-day rental appears once, as a handover", () => {
    const b = buildToday([booking({ id: "s", startAt: at(day, "09:00"), endAt: at(day, "17:00") })], day, now);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]!.kind).toBe("handover");
  });

  it("a same-day rental that is already out becomes a return, still one item", () => {
    const b = buildToday([booking({ id: "s", status: "picked_up", startAt: at(day, "09:00"), endAt: at(day, "17:00") })], day, now);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ kind: "return", done: false, action: "Check in", href: "/admin/inspect/s/checkout" });
    expect(b.goingOut).toBe(0);
    expect(b.comingBack).toBe(1);
  });

  it("an overdue rental from yesterday sorts first even though no date is today", () => {
    const b = buildToday([
      booking({ id: "a" }),
      booking({ id: "o", status: "picked_up", startAt: at("2028-03-05", "09:00"), endAt: at("2028-03-09", "16:00") }),
    ], day, now);
    expect(b.items.map((i) => i.bookingId)).toEqual(["o", "a"]);
    expect(b.items[0]).toMatchObject({ kind: "overdue", action: "Check in", href: "/admin/inspect/o/checkout" });
    expect(b.comingBack).toBe(1);
  });

  it("a 23:30 Aruba pickup is today in Aruba even though it is tomorrow in UTC", () => {
    const b = buildToday([booking({ id: "late", startAt: at(day, "23:30"), endAt: at("2028-03-12", "09:00") })], day, now);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]!.time).toBe("23:30");
  });

  it("an unpaid rental with nothing else today is a Take payment item", () => {
    const b = buildToday([booking({ id: "u", status: "picked_up", startAt: at("2028-03-05", "09:00"), endAt: at("2028-03-14", "09:00"), unpaid: true, balanceDueCents: 12000, paidNote: "Unpaid: $120.00 still due" })], day, now);
    expect(b.items[0]).toMatchObject({ kind: "unpaid", action: "Take payment", href: null, unpaid: true, note: "Unpaid: $120.00 still due" });
    expect(b.unpaid).toBe(1);
  });

  it("a return that is also unpaid stays one item, flagged unpaid", () => {
    const b = buildToday([booking({ id: "ru", status: "picked_up", startAt: at("2028-03-07", "09:00"), endAt: at(day, "16:00"), unpaid: true, balanceDueCents: 5000, paidNote: "Unpaid: $50.00 still due" })], day, now);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ kind: "return", unpaid: true });
    expect(b.unpaid).toBe(1);
  });

  it("falls back to the email local part when the customer has no name", () => {
    const b = buildToday([booking({ id: "a", customerName: "" })], day, now);
    expect(b.items[0]!.customer).toBe("kim");
  });

  it("ignores bookings that do not touch today and are not overdue or unpaid", () => {
    const b = buildToday([booking({ id: "x", startAt: at("2028-03-11", "09:00"), endAt: at("2028-03-14", "09:00") })], day, now);
    expect(b.items).toHaveLength(0);
    expect(b.total).toBe(0);
  });

  it("sorts the day by time with overdue first", () => {
    const b = buildToday([
      booking({ id: "b", startAt: at(day, "14:00"), endAt: at("2028-03-12", "14:00") }),
      booking({ id: "a", startAt: at(day, "09:00"), endAt: at("2028-03-12", "09:00") }),
      booking({ id: "r", status: "picked_up", startAt: at("2028-03-07", "09:00"), endAt: at(day, "11:00") }),
    ], day, now);
    expect(b.items.map((i) => i.bookingId)).toEqual(["a", "r", "b"]);
  });

  it("a standing unpaid balance sorts after today's timed items", () => {
    const b = buildToday([
      booking({ id: "u", status: "completed", startAt: at("2028-02-20", "09:00"), endAt: at("2028-02-25", "09:00"), unpaid: true, balanceDueCents: 9000, paidNote: "Unpaid: $90.00 still due" }),
      booking({ id: "a" }),
    ], day, now);
    expect(b.items.map((i) => i.bookingId)).toEqual(["a", "u"]);
  });
});
