import { z } from "zod";

/**
 * A real YYYY-MM-DD calendar date. The shape regex alone is not enough: it
 * accepts impossible days like 2027-02-30 or 2027-13-01, which `Date.parse`
 * silently rolls over (Feb 30 → Mar 2) or turns to NaN. Either way the bad
 * value reaches a Postgres `date` column and crashes with SQLSTATE 22008 as an
 * opaque 500, or skews buffer math. The refine rejects anything that does not
 * round-trip, so impossible dates fail validation as a clean 4xx up front.
 */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "not a real calendar date");
