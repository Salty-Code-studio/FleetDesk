import { parseTs } from "@/lib/time/format";

const DAY_MS = 86_400_000;

/** Fractional left/width percentages for a bar across visible day columns.
 *  days[] are the visible local days (YYYY-MM-DD); each column is one local day
 *  starting at 00:00 Aruba (-04:00). Returns null when fully outside. */
export function barSpan(days: string[], startAt: string, endAt: string): { left: number; width: number } | null {
  if (days.length === 0) return null;
  const rangeStart = Date.parse(`${days[0]}T00:00:00-04:00`);
  const rangeEnd = Date.parse(`${days[days.length - 1]}T00:00:00-04:00`) + DAY_MS;
  const s = Math.max(parseTs(startAt), rangeStart);
  const e = Math.min(parseTs(endAt), rangeEnd);
  if (e <= rangeStart || s >= rangeEnd) return null;
  const total = rangeEnd - rangeStart;
  return { left: ((s - rangeStart) / total) * 100, width: ((e - s) / total) * 100 };
}

export type BarState = "pending" | "confirmed" | "picked_up" | "due_back_soon" | "overdue" | "completed" | "cancelled";

/** Visual state for a bar. picked_up escalates to due_back_soon (<24h) and overdue. */
export function barState(bar: { status: string; endAt: string }, nowIso: string): BarState {
  if (bar.status !== "picked_up") return bar.status as BarState;
  const msLeft = parseTs(bar.endAt) - parseTs(nowIso);
  if (msLeft < 0) return "overdue";
  if (msLeft <= DAY_MS) return "due_back_soon";
  return "picked_up";
}
