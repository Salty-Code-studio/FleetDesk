/**
 * Aruba wall-time helpers. Aruba is UTC-4 with NO daylight saving, so a fixed
 * "-04:00" offset is always correct and lets us build timestamps without a TZ
 * database. All user-facing rendering of booking times goes through this file.
 * (When FleetDesk goes multi-tenant, this is the one module that grows a
 * per-operator timezone.)
 */
export const ARUBA_TZ = "America/Aruba";
export const ARUBA_OFFSET = "-04:00";

/** "2026-08-01" + "09:00" -> "2026-08-01T09:00:00-04:00" */
export function atAruba(date: string, time: string): string {
  return `${date}T${time}:00${ARUBA_OFFSET}`;
}

/** Epoch ms from either strict ISO or Postgres "YYYY-MM-DD HH:MM:SS+TZ" text. */
export function parseTs(s: string): number {
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  // Postgres emits a two-digit offset ("+00"); V8's strict ISO parser needs
  // "+00:00", so pad a bare ±HH offset to ±HH:00. Only pad when the offset
  // follows a "T" time component: a bare calendar date ("2026-08-01") also ends
  // in ±HH shape ("-01"), and padding that would corrupt it into NaN.
  return Date.parse(iso.replace(/(T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)([+-]\d{2})$/, "$1$2:00"));
}

const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: ARUBA_TZ }); // YYYY-MM-DD
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: ARUBA_TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const prettyFmt = new Intl.DateTimeFormat("en-US", { timeZone: ARUBA_TZ, month: "short", day: "numeric", year: "numeric" });

/** Aruba wall date "YYYY-MM-DD" of a timestamp. */
export function arubaDateOf(ts: string): string {
  return dateFmt.format(new Date(parseTs(ts)));
}

/** Aruba wall time "HH:MM" of a timestamp. */
export function arubaTimeOf(ts: string): string {
  return timeFmt.format(new Date(parseTs(ts)));
}

/** Now as an Aruba fixed-offset ISO timestamp (client-safe: no server imports). */
export function arubaNowIso(): string {
  const d = new Date();
  return atAruba(dateFmt.format(d), timeFmt.format(d));
}

/** Shift by whole hours, returning fixed-offset Aruba ISO. */
export function addHoursIso(ts: string, hours: number): string {
  const d = new Date(parseTs(ts) + hours * 3_600_000);
  return atAruba(dateFmt.format(d), timeFmt.format(d));
}

/** "Aug 1, 2026 at 09:00" (dash free, Aruba wall time). */
export function formatDateTime(ts: string): string {
  return `${prettyFmt.format(new Date(parseTs(ts)))} at ${arubaTimeOf(ts)}`;
}

/** "Aug 1, 2026" */
export function formatDate(ts: string): string {
  return prettyFmt.format(new Date(parseTs(ts)));
}

/** "09:00" */
export function formatTime(ts: string): string {
  return arubaTimeOf(ts);
}
