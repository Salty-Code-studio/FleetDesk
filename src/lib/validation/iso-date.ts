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

/**
 * A real ISO 8601 timestamp WITH an explicit UTC offset (Z or ±HH:MM). Naive
 * timestamps are rejected on purpose: a time without an offset silently shifts
 * by the server's timezone. Round-trip refine rejects impossible datetimes the
 * same way isoDate does for dates.
 */
export const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/, "must be an ISO timestamp with offset")
  .refine((s) => {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return false;
    // Round-trip the calendar part in the value's own offset to reject Feb 30 etc.
    // (zod still runs this refine when the regex above fails, so guard the match.)
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T/);
    if (!m) return false;
    const probe = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    return probe.toISOString().slice(0, 10) === `${m[1]}-${m[2]}-${m[3]}`;
  }, "not a real timestamp");
