/**
 * The tiny status chip on a planning bar. Pure: the board decides nothing
 * about colour, it only asks "what chip does this bar wear?". Tones map to
 * CSS classes .pl-bar--tone-<tone>; see admin.css.
 */
import type { BarState } from "@/lib/admin/bar-span";

export type ChipTone = "pending" | "confirmed" | "out" | "due" | "late" | "done" | "unpaid";
export interface BarChip { label: string; tone: ChipTone }

const BY_STATE: Record<BarState, BarChip> = {
  pending: { label: "pending", tone: "pending" },
  confirmed: { label: "booked", tone: "confirmed" },
  picked_up: { label: "out", tone: "out" },
  due_back_soon: { label: "due", tone: "due" },
  overdue: { label: "late", tone: "late" },
  completed: { label: "back", tone: "done" },
  cancelled: { label: "cancelled", tone: "done" },
};

export function chipFor(state: BarState, unpaid: boolean, manual: boolean): BarChip {
  if (unpaid) return { label: "unpaid", tone: "unpaid" };
  const base = BY_STATE[state];
  return manual ? { ...base, label: `${base.label} ✦` } : base;
}
