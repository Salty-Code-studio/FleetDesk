import { parseTs } from "@/lib/time/format";

const DAY_MS = 86_400_000;

/**
 * Horizontal placement of a booking inside a single day's 24-hour grid, used by
 * the board's day-zoom view. `day` is a local Aruba day (YYYY-MM-DD); the grid
 * runs 00:00 → 24:00 Aruba (-04:00), so left/width are percentages of that day.
 *
 * Returns null when the booking does not overlap the day at all. `cutStart` /
 * `cutEnd` flag a multi-day rental that began before, or runs past, this day, so
 * the UI can draw a "continues" marker instead of implying a same-day handover.
 */
export function hourSpan(
  day: string,
  startAt: string,
  endAt: string,
): { left: number; width: number; cutStart: boolean; cutEnd: boolean } | null {
  const dayStart = Date.parse(`${day}T00:00:00-04:00`);
  const dayEnd = dayStart + DAY_MS;
  const startMs = parseTs(startAt);
  const endMs = parseTs(endAt);
  const s = Math.max(startMs, dayStart);
  const e = Math.min(endMs, dayEnd);
  if (e <= dayStart || s >= dayEnd) return null;
  return {
    left: ((s - dayStart) / DAY_MS) * 100,
    width: ((e - s) / DAY_MS) * 100,
    cutStart: startMs < dayStart,
    cutEnd: endMs > dayEnd,
  };
}
