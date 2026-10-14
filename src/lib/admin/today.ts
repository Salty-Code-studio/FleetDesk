/**
 * The Today queue: what needs the operator today, in time order.
 *
 * One item per booking. Priority when a booking qualifies for more than one
 * kind: overdue > return > handover > unpaid. Unpaid is also carried as a flag
 * on every item, so a return that still owes money shows once, flagged.
 *
 * Pure: no database, no React, no clock. The route passes the Aruba day and
 * "now" so the rule is unit-testable (see today-queue.test.ts).
 */
import { arubaDateOf, arubaTimeOf, parseTs } from "@/lib/time/format";

export type TodayKind = "overdue" | "return" | "handover" | "unpaid";

export interface TodayBookingInput {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
  customerName: string;
  customerEmail: string;
  plate: string;
  vehicleName: string;
  unpaid: boolean;
  balanceDueCents: number;
  paidNote: string | null;
}

export interface TodayItem {
  bookingId: string;
  kind: TodayKind;
  /** Full timestamp the item is anchored to (pickup or return). */
  at: string;
  /** HH:MM in Aruba time, for the row. */
  time: string;
  customer: string;
  vehicle: string;
  plate: string;
  done: boolean;
  /** Button label. */
  action: string;
  /** Wizard link, or null when the action opens the booking sheet. */
  href: string | null;
  unpaid: boolean;
  note: string | null;
}

export interface TodayBoard {
  day: string;
  items: TodayItem[];
  goingOut: number;
  comingBack: number;
  unpaid: number;
  done: number;
  total: number;
}

const OUT_OR_DONE = new Set(["picked_up", "completed"]);
const KIND_ORDER: Record<TodayKind, number> = { overdue: 0, return: 1, handover: 1, unpaid: 1 };

function customerLabel(b: TodayBookingInput): string {
  return b.customerName || b.customerEmail.split("@")[0]!;
}

function classify(b: TodayBookingInput, day: string, nowIso: string): Omit<TodayItem, "customer" | "vehicle" | "plate" | "unpaid" | "note" | "bookingId"> | null {
  const startsToday = arubaDateOf(b.startAt) === day;
  const endsToday = arubaDateOf(b.endAt) === day;

  if (b.status === "picked_up" && !endsToday && parseTs(b.endAt) < parseTs(nowIso)) {
    return { kind: "overdue", at: b.endAt, time: arubaTimeOf(b.endAt), done: false, action: "Check in", href: `/admin/inspect/${b.id}/checkout` };
  }
  if (startsToday && b.status === "pending") {
    return { kind: "handover", at: b.startAt, time: arubaTimeOf(b.startAt), done: false, action: "Confirm first", href: null };
  }
  if (startsToday && b.status === "confirmed") {
    return { kind: "handover", at: b.startAt, time: arubaTimeOf(b.startAt), done: false, action: "Start handover", href: `/admin/inspect/${b.id}/checkin` };
  }
  if (startsToday && OUT_OR_DONE.has(b.status)) {
    return { kind: "handover", at: b.startAt, time: arubaTimeOf(b.startAt), done: true, action: "Handed over", href: null };
  }
  if (endsToday && b.status === "picked_up") {
    return { kind: "return", at: b.endAt, time: arubaTimeOf(b.endAt), done: false, action: "Check in", href: `/admin/inspect/${b.id}/checkout` };
  }
  if (endsToday && b.status === "completed") {
    return { kind: "return", at: b.endAt, time: arubaTimeOf(b.endAt), done: true, action: "Back", href: null };
  }
  if (b.unpaid && OUT_OR_DONE.has(b.status)) {
    return { kind: "unpaid", at: b.endAt, time: arubaTimeOf(b.endAt), done: false, action: "Take payment", href: null };
  }
  return null;
}

export function buildToday(bookings: TodayBookingInput[], day: string, nowIso: string): TodayBoard {
  const items: TodayItem[] = [];
  for (const b of bookings) {
    const c = classify(b, day, nowIso);
    if (!c) continue;
    items.push({ ...c, bookingId: b.id, customer: customerLabel(b), vehicle: b.vehicleName, plate: b.plate, unpaid: b.unpaid, note: b.paidNote });
  }
  items.sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (parseTs(a.at) - parseTs(b.at)));

  return {
    day,
    items,
    goingOut: items.filter((i) => i.kind === "handover").length,
    comingBack: items.filter((i) => i.kind === "return" || i.kind === "overdue").length,
    unpaid: items.filter((i) => i.unpaid).length,
    done: items.filter((i) => i.done).length,
    total: items.length,
  };
}
