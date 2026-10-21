/**
 * The booking sheet's stage track. Pure: it names where a booking sits on
 * the Reserved, Paid, Out, Back, Closed track and the one next step. The
 * hrefs point at the same inspect routes as today.ts.
 */
export type StageKey = "reserved" | "paid" | "out" | "back" | "closed";

export const STAGES: { key: StageKey; label: string }[] = [
  { key: "reserved", label: "Reserved" },
  { key: "paid", label: "Paid" },
  { key: "out", label: "Out" },
  { key: "back", label: "Back" },
  { key: "closed", label: "Closed" },
];

export type NextAction =
  | { kind: "confirm"; label: "Confirm booking" }
  | { kind: "link"; label: "Start handover" | "Check in return"; href: string }
  | { kind: "pay"; label: "Take payment"; amountCents: number };

export interface StageView {
  cancelled: boolean;
  current: StageKey | null;
  next: NextAction | null;
}

export interface StageInput {
  id: string;
  status: string;
  balanceDueCents: number;
  paymentMode: "online" | "desk";
}

export function stageFor(i: StageInput): StageView {
  switch (i.status) {
    case "pending":
      return {
        cancelled: false,
        current: "reserved",
        next: i.paymentMode === "desk" ? { kind: "confirm", label: "Confirm booking" } : null,
      };
    case "confirmed":
      return {
        cancelled: false,
        current: "paid",
        next: { kind: "link", label: "Start handover", href: `/admin/inspect/${i.id}/checkin` },
      };
    case "picked_up":
      return {
        cancelled: false,
        current: "out",
        next: { kind: "link", label: "Check in return", href: `/admin/inspect/${i.id}/checkout` },
      };
    case "completed":
      return i.balanceDueCents > 0
        ? {
            cancelled: false,
            current: "back",
            next: { kind: "pay", label: "Take payment", amountCents: i.balanceDueCents },
          }
        : { cancelled: false, current: "closed", next: null };
    case "cancelled":
      return { cancelled: true, current: null, next: null };
    default:
      return { cancelled: false, current: null, next: null };
  }
}

export interface SheetActions { move: boolean; extend: boolean; swap: boolean; cancel: boolean }

/** Which Actions-row buttons the sheet offers. Mirrors the server guards:
 *  move-booking.ts (pending/confirmed), extend-booking.ts (confirmed/picked_up),
 *  swap (any live booking, a car can break down mid-rental), cancel
 *  (pending/confirmed). Completed and cancelled offer nothing. */
export function sheetActions(status: string): SheetActions {
  return {
    move: status === "pending" || status === "confirmed",
    extend: status === "confirmed" || status === "picked_up",
    swap: status === "pending" || status === "confirmed" || status === "picked_up",
    cancel: status === "pending" || status === "confirmed",
  };
}

/** Whether the head shows the next-stage button for this viewer. Take payment
 *  posts to the owner-only desk-payment route, so staff see the track only. */
export function showNextFor(next: NextAction | null, role: "owner" | "staff"): boolean {
  if (!next) return false;
  return next.kind !== "pay" || role === "owner";
}
