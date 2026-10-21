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
