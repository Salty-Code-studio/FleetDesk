/**
 * Driver age maths, pure and dependency-free so the public booking page and
 * the server share one rule (the licence module re-exports these).
 */

/** Whole years from `dob` to `onDate` (both YYYY-MM-DD). */
export function ageOn(dob: string, onDate: string): number {
  const [by, bm, bd] = dob.split("-").map(Number) as [number, number, number];
  const [oy, om, od] = onDate.split("-").map(Number) as [number, number, number];
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age -= 1;
  return age;
}

export type DriverAgeBand = "under_min" | "young" | "standard";

/** The main driver's band at pick-up against the operator's thresholds. */
export function driverAgeBand(
  dob: string,
  pickupDate: string,
  s: { minDriverAge: number; youngDriverAge: number },
): DriverAgeBand {
  const age = ageOn(dob, pickupDate);
  if (age < s.minDriverAge) return "under_min";
  if (age < s.youngDriverAge) return "young";
  return "standard";
}

/** A date of birth a real driver could have: a valid calendar date, not in
 *  the future, and under 120 years ago. */
export function plausibleDob(dob: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return false;
  const d = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dob) return false;
  return dob <= today && ageOn(dob, today) < 120;
}
