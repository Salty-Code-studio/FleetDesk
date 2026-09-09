/**
 * Selectable + accepted ranges for the three driver-licence dates.
 *
 * Shared deliberately by the public booking wizard (DatePicker derives its year
 * dropdown from min/max, so an unbounded field silently topped out at today + 5
 * years) and by server-side validateLicense. One source of truth means the
 * picker can never offer a date the server rejects, and no other caller can
 * push one past the server either.
 *
 * NOTE: zero imports. This module is pulled into a "use client" component, so
 * it must stay free of anything server-only.
 */

/** A driver older than this is assumed to be a typo, not a customer. */
export const LICENCE_DOB_MAX_AGE_YEARS = 100;
/** No real licence in circulation was issued longer ago than this. */
export const LICENCE_ISSUE_MAX_AGE_YEARS = 50;
/** Covers the long Aruban and Bonairian terms with room to spare. */
export const LICENCE_EXPIRY_MAX_YEARS_AHEAD = 25;

export interface DateBound { min: string; max: string }
export interface LicenceDateBounds {
  dob: DateBound;
  issueDate: DateBound;
  expiryDate: DateBound;
}

/** Shift a YYYY-MM-DD date by whole years, clamping 29 Feb to 28 Feb. */
export function shiftYearsISO(iso: string, years: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const targetYear = y + years;
  // Day 0 of month m (1-based) is the last day of month m - 1 in JS's 0-based
  // month indexing, i.e. the last day of the month we actually want.
  const daysInMonth = new Date(Date.UTC(targetYear, m, 0)).getUTCDate();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(targetYear, 4)}-${p(m)}-${p(Math.min(d, daysInMonth))}`;
}

export function licenceDateBounds(todayIso: string): LicenceDateBounds {
  return {
    dob: {
      min: shiftYearsISO(todayIso, -LICENCE_DOB_MAX_AGE_YEARS),
      max: todayIso,
    },
    issueDate: {
      min: shiftYearsISO(todayIso, -LICENCE_ISSUE_MAX_AGE_YEARS),
      max: todayIso,
    },
    expiryDate: {
      min: todayIso,
      max: shiftYearsISO(todayIso, LICENCE_EXPIRY_MAX_YEARS_AHEAD),
    },
  };
}
