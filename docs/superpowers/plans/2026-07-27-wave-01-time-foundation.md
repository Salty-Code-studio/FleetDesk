# Time-Aware Booking (Wave 01: Time Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the whole booking system from date-only granularity to real pickup/return timestamps (America/Aruba wall time), with the DB no-overlap constraint on `tstzrange`, an hours-based turnaround buffer, business-hours time pickers in the wizard, a fractional-day planning grid with new bar states, timed vehicle blocks, and block/blackout conflict warnings on desk actions.

**Architecture:** One early "big cutover" task renames `start_date/end_date/buffer_end_date` → `start_at/end_at/buffer_end_at` (timestamptz, drizzle `mode: "string"`) across schema + engine + fixtures while keeping day-based semantics via a 09:00 default, so the suite is green again at that task's end. Later tasks then layer real time behavior on top: validation, settings, wizard UI, grid UI, conflict warnings, display formatting. Pricing stays per-day (`ceil(hours/24)`).

**Tech Stack:** Next.js 15 App Router, Drizzle ORM (PGlite dev/test, Postgres prod), zod, vitest.

## Global Constraints

- Tests: `npm test -- --no-file-parallelism` (single file: `npm test -- --no-file-parallelism src/test/<file>.test.ts`). Typecheck `npx tsc --noEmit`, lint `npm run lint`.
- NEVER `npm run build` while a `next dev` server is running.
- Migrations: edit schema TS, run `npm run db:generate`, then REPLACE the generated SQL file's body with the hand-written SQL shown in the task (keeps drizzle snapshots truthful — this is the repo's 0002/0007 precedent). Register nothing by hand; `db:generate` maintains `drizzle/meta/_journal.json`.
- Admin mutations via `mutate(req, action, fn)`, reads via `read(req, fn)` from `src/lib/admin/guard.ts`.
- Admin UI reuses `Modal, Drawer, useToast, useConfirm` from `@/app/admin/_ui`; `DatePicker, Select` from `@/components/ui`. Strict CSP, no external assets. Money = integer cents.
- Copy is dash-free (no em-dashes). Timezone: America/Aruba (UTC-4, **no DST**, so a fixed `-04:00` offset is always correct).
- Seam names are canonical: see `docs/superpowers/plans/SEAMS-2026-07-wave.md`. This plan OWNS: `startAt/endAt/bufferEndAt`, `turnaroundBufferHours`, `openingTime/closingTime`, `isoDateTime`, `src/lib/time/format.ts`, `TimeSelect`, the rebuilt exclusion constraint, and the `picked_up` enum VALUE (first written by wave 06).

---

### Task 1: Time utilities + `isoDateTime` validation (pure code, no schema change)

**Files:**
- Create: `src/lib/time/format.ts`
- Modify: `src/lib/validation/iso-date.ts`
- Test: `src/test/time-format.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by every later task): `isoDateTime` (zod), `ARUBA_OFFSET`, `ARUBA_TZ`, `atAruba(date, time)`, `parseTs(s)`, `arubaDateOf(ts)`, `arubaTimeOf(ts)`, `addHoursIso(ts, hours)`, `formatDateTime(ts)`, `formatDate(ts)`, `formatTime(ts)`.

- [ ] **Step 1: Write the failing test**

Create `src/test/time-format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  atAruba, parseTs, arubaDateOf, arubaTimeOf, addHoursIso, formatDateTime, formatDate, formatTime,
} from "@/lib/time/format";
import { isoDateTime } from "@/lib/validation/iso-date";

describe("time/format", () => {
  it("atAruba builds a fixed-offset ISO timestamp", () => {
    expect(atAruba("2026-08-01", "09:00")).toBe("2026-08-01T09:00:00-04:00");
  });

  it("parseTs handles ISO and Postgres string forms identically", () => {
    const iso = parseTs("2026-08-01T09:00:00-04:00");
    const pg = parseTs("2026-08-01 13:00:00+00");
    expect(iso).toBe(pg);
    expect(iso).toBe(Date.parse("2026-08-01T13:00:00Z"));
  });

  it("arubaDateOf / arubaTimeOf recover the Aruba wall date and time", () => {
    expect(arubaDateOf("2026-08-01 13:00:00+00")).toBe("2026-08-01");
    expect(arubaTimeOf("2026-08-01 13:00:00+00")).toBe("09:00");
    expect(arubaDateOf("2026-08-01T01:30:00Z")).toBe("2026-07-31"); // 21:30 previous day in Aruba
    expect(arubaTimeOf("2026-08-01T01:30:00Z")).toBe("21:30");
  });

  it("addHoursIso shifts by whole hours and returns fixed-offset ISO", () => {
    expect(addHoursIso("2026-08-01T09:00:00-04:00", 24)).toBe("2026-08-02T09:00:00-04:00");
    expect(addHoursIso("2026-08-01T22:00:00-04:00", 3)).toBe("2026-08-02T01:00:00-04:00");
  });

  it("formatters render Aruba wall time, dash free", () => {
    expect(formatDateTime("2026-08-01T09:00:00-04:00")).toBe("Aug 1, 2026 at 09:00");
    expect(formatDate("2026-08-01T09:00:00-04:00")).toBe("Aug 1, 2026");
    expect(formatTime("2026-08-01T13:30:00-04:00")).toBe("13:30");
  });
});

describe("isoDateTime", () => {
  it("accepts offset ISO timestamps", () => {
    expect(isoDateTime.safeParse("2026-08-01T09:00:00-04:00").success).toBe(true);
    expect(isoDateTime.safeParse("2026-08-01T13:00:00Z").success).toBe(true);
  });
  it("rejects date-only, naive, and impossible values", () => {
    expect(isoDateTime.safeParse("2026-08-01").success).toBe(false);
    expect(isoDateTime.safeParse("2026-08-01T09:00:00").success).toBe(false); // no offset
    expect(isoDateTime.safeParse("2026-02-30T09:00:00Z").success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --no-file-parallelism src/test/time-format.test.ts`
Expected: FAIL — cannot resolve `@/lib/time/format`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/time/format.ts`:

```ts
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
  return Date.parse(s.includes("T") ? s : s.replace(" ", "T"));
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
```

Append to `src/lib/validation/iso-date.ts` (keep `isoDate` untouched above it):

```ts
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
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T/)!;
    const probe = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    return probe.toISOString().slice(0, 10) === `${m[1]}-${m[2]}-${m[3]}`;
  }, "not a real timestamp");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --no-file-parallelism src/test/time-format.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/time/format.ts src/lib/validation/iso-date.ts src/test/time-format.test.ts
git commit -m "feat(time): Aruba wall-time helpers + isoDateTime validation"
```

---

### Task 2: The big cutover — timestamptz schema, rebuilt constraint, engine rename, green suite

This is deliberately one task: renaming `startDate/endDate/bufferEndDate` → `startAt/endAt/bufferEndAt` breaks every consumer at once, so the only honest boundary is "the whole suite is green again". Times default to 09:00 Aruba at every boundary in this task; real time behavior arrives in Tasks 3-7.

**Files:**
- Modify: `src/lib/db/schema/bookings.ts`, `src/lib/db/schema/fleet.ts`, `src/lib/db/schema/settings.ts`
- Create (via `db:generate`, then replace body): two new migrations in `./drizzle` (first: enum value; second: columns + constraint)
- Modify: `src/lib/booking/availability.ts`, `src/lib/booking/quote.ts`, `src/lib/booking/create.ts`, `src/lib/booking/public.ts`, `src/lib/booking/classes.ts`, `src/lib/booking/customer-bookings.ts`, `src/lib/booking/license.ts`, `src/lib/admin/planning.ts`, `src/lib/admin/manual-booking.ts`, `src/lib/admin/move-booking.ts`, `src/lib/admin/reports.ts`, `src/lib/admin/settings.ts`, `src/lib/payments/checkout.ts`, `src/lib/payments/holds.ts`, `src/lib/email/notifications.ts`, `src/lib/email/templates.ts`, all API routes under `src/app/api/` that parse `startDate/endDate` or `pickup/return` params, `scripts/seed.ts`, `scripts/seed-demo-bookings.ts` if present
- Modify: every test fixture in `src/test/` that builds date-only bookings
- Test: the ENTIRE existing suite

**Interfaces:**
- Consumes: Task 1 helpers (`atAruba`, `parseTs`, `addHoursIso`, `arubaDateOf`, `isoDateTime`).
- Produces: `bookings.startAt/endAt/bufferEndAt` (timestamptz, drizzle `mode: "string"`), `availabilityBlocks.startAt/endAt`, `settings.turnaroundBufferHours` (int, default 24), `settings.openingTime`/`closingTime` (text, "08:00"/"18:00"), booking_status value `picked_up` (present, unused), `rentalDays(startAt, endAt)` = ceil(hours/24) min 1, `checkAvailability(vehicleId, startAt, endAt, { turnaroundBufferHours })`, `validateDates(startAt, endAt, settings, nowIso)`, `normalizeRange({ pickup, return })` boundary helper (date-only in → 09:00 default, but see Task 3 for openingTime), API request/response fields renamed `startDate/endDate` → `startAt/endAt` (public quote/booking payloads, admin planning/move/manual payloads).

- [ ] **Step 1: Schema edit — bookings**

In `src/lib/db/schema/bookings.ts`: add `"picked_up"` to the `bookingStatus` enum AND swap the three date columns. Replace lines 7 and 26-28 and the checks:

```ts
export const bookingStatus = pgEnum("booking_status", ["pending", "confirmed", "picked_up", "cancelled", "completed"]);
```

```ts
  startAt: timestamp("start_at", { withTimezone: true, mode: "string" }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true, mode: "string" }).notNull(),
  bufferEndAt: timestamp("buffer_end_at", { withTimezone: true, mode: "string" }).notNull(), // endAt + turnaround buffer hours; drives the exclusion constraint
```

```ts
}, (t) => [
  check("bookings_dates", sql`${t.endAt} > ${t.startAt}`),
  check("bookings_buffer", sql`${t.bufferEndAt} >= ${t.endAt}`),
]);
```

Update the doc comment block above the table: semantics are now `[startAt, endAt)` timestamptz and the constraint is `tstzrange(start_at, buffer_end_at, '[)')` over `status IN ('pending','confirmed','picked_up')`.

- [ ] **Step 2: Schema edit — availability_blocks and settings**

`src/lib/db/schema/fleet.ts` — replace `startDate`/`endDate` on `availabilityBlocks`:

```ts
  startAt: timestamp("start_at", { withTimezone: true, mode: "string" }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true, mode: "string" }).notNull(),
```

and the check becomes `check("availability_blocks_dates", sql`${t.endAt} > ${t.startAt}`)`. (Import `timestamp` is already there; drop unused `date` import if nothing else uses it.)

`src/lib/db/schema/settings.ts` — replace `turnaroundBufferDays` (line 14) with:

```ts
  turnaroundBufferHours: integer("turnaround_buffer_hours").notNull().default(24),
  openingTime: text("opening_time").notNull().default("08:00"),
  closingTime: text("closing_time").notNull().default("18:00"),
```

`blackoutDates` stays date-based. Do NOT touch it.

- [ ] **Step 3: Generate migration 1 (enum value only)**

Temporarily stash the column edits so only the enum add is pending: the practical order is (a) make ONLY the `bookingStatus` enum edit, (b) `npm run db:generate` → produces a migration containing just `ALTER TYPE "booking_status" ADD VALUE 'picked_up' ...`, (c) then apply the column edits from Steps 1-2 and `npm run db:generate` again → second migration. Two files matter because Postgres cannot add an enum value and use it in the same transaction, and the migrator wraps each file in its own transaction.

- [ ] **Step 4: Replace migration 2's body with data-preserving SQL**

Open the second generated file (name will be `00NN_<auto-name>.sql`, NN = next number after the current journal tail; verify with `python3 -c "import json;print(json.load(open('drizzle/meta/_journal.json'))['entries'][-1]['tag'])"`). Replace its entire body with:

```sql
-- Time foundation: date -> timestamptz (Aruba wall time), hours buffer,
-- exclusion constraint over tstzrange incl. picked_up. Data-preserving.

-- bookings ----------------------------------------------------------------
ALTER TABLE "bookings" ADD COLUMN "start_at" timestamptz;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "end_at" timestamptz;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "buffer_end_at" timestamptz;--> statement-breakpoint
UPDATE "bookings" SET
  "start_at" = ("start_date" + time '09:00')::timestamp AT TIME ZONE 'America/Aruba',
  "end_at" = ("end_date" + time '09:00')::timestamp AT TIME ZONE 'America/Aruba',
  "buffer_end_at" = ("buffer_end_date" + time '09:00')::timestamp AT TIME ZONE 'America/Aruba';--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "start_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "end_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "buffer_end_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_no_overlap";--> statement-breakpoint
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_dates";--> statement-breakpoint
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_buffer";--> statement-breakpoint
ALTER TABLE "bookings" DROP COLUMN "start_date";--> statement-breakpoint
ALTER TABLE "bookings" DROP COLUMN "end_date";--> statement-breakpoint
ALTER TABLE "bookings" DROP COLUMN "buffer_end_date";--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_dates" CHECK ("end_at" > "start_at");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_buffer" CHECK ("buffer_end_at" >= "end_at");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist (
    "vehicle_id" WITH =,
    tstzrange("start_at", "buffer_end_at", '[)') WITH &&
  ) WHERE (status IN ('pending', 'confirmed', 'picked_up'));--> statement-breakpoint

-- availability_blocks ------------------------------------------------------
ALTER TABLE "availability_blocks" ADD COLUMN "start_at" timestamptz;--> statement-breakpoint
ALTER TABLE "availability_blocks" ADD COLUMN "end_at" timestamptz;--> statement-breakpoint
UPDATE "availability_blocks" SET
  "start_at" = ("start_date")::timestamp AT TIME ZONE 'America/Aruba',
  "end_at" = ("end_date")::timestamp AT TIME ZONE 'America/Aruba';--> statement-breakpoint
ALTER TABLE "availability_blocks" ALTER COLUMN "start_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "availability_blocks" ALTER COLUMN "end_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "availability_blocks" DROP CONSTRAINT IF EXISTS "availability_blocks_dates";--> statement-breakpoint
ALTER TABLE "availability_blocks" DROP COLUMN "start_date";--> statement-breakpoint
ALTER TABLE "availability_blocks" DROP COLUMN "end_date";--> statement-breakpoint
ALTER TABLE "availability_blocks" ADD CONSTRAINT "availability_blocks_dates" CHECK ("end_at" > "start_at");--> statement-breakpoint

-- settings -----------------------------------------------------------------
ALTER TABLE "settings" ADD COLUMN "turnaround_buffer_hours" integer NOT NULL DEFAULT 24;--> statement-breakpoint
UPDATE "settings" SET "turnaround_buffer_hours" = "turnaround_buffer_days" * 24;--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "turnaround_buffer_days";--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "opening_time" text NOT NULL DEFAULT '08:00';--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "closing_time" text NOT NULL DEFAULT '18:00';
```

- [ ] **Step 5: Migration smoke test**

Run: `npm run db:migrate` against a scratch PGlite dir (`DATABASE_URL=pglite://.migration-smoke npm run db:migrate`), then `rm -rf .migration-smoke`.
Expected: both migrations apply cleanly, exit 0. (The test suite re-runs migrations per worker anyway; this just fails fast.)

- [ ] **Step 6: Engine rename — booking availability + quote**

`src/lib/booking/quote.ts` — replace `rentalDays` (lines 57-62):

```ts
import { parseTs } from "@/lib/time/format";

/** Whole charged rental days from timestamps: ceil of elapsed hours / 24, min 1.
 *  09:00 -> 09:00 next day = 1 day; any overrun starts the next day. */
export function rentalDays(startAt: string, endAt: string): number {
  const hours = (parseTs(endAt) - parseTs(startAt)) / 3_600_000;
  return Math.max(1, Math.ceil(hours / 24));
}
```

`src/lib/booking/availability.ts` — the module keeps its exported names; the bodies move to timestamps:

```ts
import { and, eq, ne, lt, gt, sql, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { vehicles, bookings, bookingAddOns, availabilityBlocks, blackoutDates } from "@/lib/db/schema";
import { rentalDays } from "@/lib/booking/quote";
import { addHoursIso, arubaDateOf, parseTs } from "@/lib/time/format";
import { Errors } from "@/lib/http/errors";

export interface DateGuardSettings {
  minRentalDays: number;
  maxRentalDays: number;
  maxAdvanceDays: number;
  turnaroundBufferHours: number;
}

/** Throws a 400 if the timestamps break a guardrail. `nowIso` is a full timestamp. */
export function validateDates(startAt: string, endAt: string, settings: DateGuardSettings, nowIso: string): void {
  if (Number.isNaN(parseTs(startAt)) || Number.isNaN(parseTs(endAt))) {
    throw Errors.badRequest("Pick-up and return must be timestamps");
  }
  if (parseTs(endAt) <= parseTs(startAt)) throw Errors.badRequest("Return must be after pick-up");
  if (parseTs(startAt) < parseTs(nowIso)) throw Errors.badRequest("Pick-up cannot be in the past");
  const days = rentalDays(startAt, endAt);
  if (days < settings.minRentalDays) throw Errors.badRequest(`Minimum rental is ${settings.minRentalDays} day(s)`);
  if (days > settings.maxRentalDays) throw Errors.badRequest(`Maximum rental is ${settings.maxRentalDays} day(s)`);
  const advanceDays = Math.floor((parseTs(startAt) - parseTs(nowIso)) / 86_400_000);
  if (advanceDays > settings.maxAdvanceDays) throw Errors.badRequest(`Bookings open at most ${settings.maxAdvanceDays} day(s) ahead`);
}
```

`checkAvailability` keeps its exact shape but: parameter `settings: { turnaroundBufferHours: number }`, `const newBufferEnd = addHoursIso(endAt, settings.turnaroundBufferHours);`, booking clash predicate becomes `inArray(bookings.status, ["pending", "confirmed", "picked_up"])` with `lt(bookings.startAt, newBufferEnd)` / `gt(bookings.bufferEndAt, startAt)`; block overlap uses `availabilityBlocks.startAt/endAt` against `endAt/startAt`; blackout comparison converts to Aruba wall dates: `lt(blackoutDates.startDate, arubaDateOf(endAt) === arubaTimeOf-safe? use the exclusive-day rule below)`. Concretely for blackouts (whole local days):

```ts
  const blackout = await db.select({ id: blackoutDates.id }).from(blackoutDates).where(and(
    lt(blackoutDates.startDate, arubaDateOf(addHoursIso(endAt, -1)) < arubaDateOf(endAt) ? arubaDateOf(endAt) : arubaDateOf(addHoursIso(endAt, 24))),
    gt(blackoutDates.endDate, arubaDateOf(startAt)),
  )).limit(1);
```

Simplify honestly: a rental touches local day D iff `arubaDateOf(startAt) < blackout.endDate AND blackout.startDate <= lastTouchedDay` where `lastTouchedDay = arubaDateOf(addHoursIso(endAt, 0))` when the return time is after 00:00 of that day. The clean implementation (use this one):

```ts
  const firstDay = arubaDateOf(startAt);                       // first local day touched
  const endExclusiveDay = arubaTimeOf(endAt) === "00:00"       // 00:00 return touches nothing of that day
    ? arubaDateOf(endAt)
    : arubaDateOf(addHoursIso(endAt, 24));                     // else the day after the return day
  const blackout = await db.select({ id: blackoutDates.id }).from(blackoutDates).where(and(
    lt(blackoutDates.startDate, endExclusiveDay),
    gt(blackoutDates.endDate, firstDay),
  )).limit(1);
```

(import `arubaTimeOf` too). `addOnHeadroom(addOnId, stock, startAt, endAt, ...)`: predicates become `lt(bookings.startAt, endAt)` / `gt(bookings.endAt, startAt)` and status list gains `"picked_up"`.

- [ ] **Step 7: Engine rename — create, public, classes, manual, move, holds, customer-bookings, license**

Mechanical rules for all of these (apply file by file, run `npx tsc --noEmit` after each to drain errors):

1. Zod boundary fields rename with a compat shim. In `src/lib/booking/create.ts` `BookingCreateSchema`: replace `startDate: isoDate, endDate: isoDate` with `startAt: isoDateTime, endAt: isoDateTime`. Same rename in `MoveSchema` (optional fields) and `ManualBookingSchema`. API routes that read `?pickup=&return=` query params (availability, classes, quote body) accept BOTH forms via the new boundary helper — add to `src/lib/booking/public.ts`:

```ts
import { atAruba } from "@/lib/time/format";
import { isoDate } from "@/lib/validation/iso-date";

/** Boundary compat: a bare YYYY-MM-DD (Phase 1 deep links, old clients) becomes
 *  that date at 09:00 Aruba. Full timestamps pass through unchanged.
 *  NOTE: Task 3 swaps the hardcoded 09:00 for settings.openingTime. */
export function normalizeTs(value: string): string {
  return isoDate.safeParse(value).success ? atAruba(value, "09:00") : value;
}
```

2. `today: string` parameters (`createBooking(input, today)`, `publicQuote(req, today)`) become `nowIso: string`; `arubaToday()` STAYS (blackouts, retention day math) and gains a sibling in `public.ts`:

```ts
/** Now as a Aruba fixed-offset ISO timestamp. */
export function arubaNowIso(): string {
  const d = new Date();
  return atAruba(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Aruba" }).format(d),
    new Intl.DateTimeFormat("en-GB", { timeZone: "America/Aruba", hour: "2-digit", minute: "2-digit", hour12: false }).format(d),
  );
}
```

Call sites that passed `arubaToday()` pass `arubaNowIso()`.

3. `bufferEndDate` computations become `const bufferEndAt = addHoursIso(input.endAt, settings.turnaroundBufferHours);` (create.ts line 135 area, manual-booking.ts, move-booking.ts). Insert values use `startAt/endAt/bufferEndAt`.

4. `retainUntil` in create.ts becomes `new Date(parseTs(input.endAt) + settings.licenseRetentionDays * 86_400_000)`.

5. Add-on overlap recount predicates inside the create/move transactions: `lt(bookings.startAt, input.endAt)`, `gt(bookings.endAt, input.startAt)`, status list gains `"picked_up"`.

6. `validateLicense(... rentalStart, rentalEnd ...)` in `license.ts`: it compares the licence expiry date against rental end. Pass `arubaDateOf(input.endAt)` so it keeps comparing dates. Do not change LicenseSchema.

7. `classes.ts` `getClasses(pickup, ret, ...)`: parameters are now timestamps (already normalized by the route); it forwards to `checkAvailability` unchanged otherwise.

8. `customer-bookings.ts`, `holds.ts` (`expireStaleHolds`), `reports.ts`: rename column references (`bookings.startDate` → `bookings.startAt` etc.). In `reports.ts`, wherever a `YYYY-MM-DD` is needed for month-slicing/overlap-day math, wrap with `arubaDateOf(...)`. Existing month-key logic then works unchanged.

9. `checkout.ts` Stripe line description `${booking.startDate} to ${booking.endDate}` → `${formatDateTime(booking.startAt)} to ${formatDateTime(booking.endAt)}` (import from `@/lib/time/format`).

10. `email/templates.ts` + `email/notifications.ts`: date renders go through `formatDateTime`. Keep subjects dash free.

11. `scripts/seed.ts` (+ `seed-demo-bookings.ts` if present): seeded bookings/blocks get `startAt: atAruba(date, "09:00")` style values.

- [ ] **Step 8: API routes**

For each route that parses dates, apply the boundary rule (normalize, then validate as timestamp):

- `src/app/api/availability/route.ts`, `src/app/api/classes/route.ts`: `pickup`/`return` query params run through `normalizeTs()` then `isoDateTime.parse()`; downstream calls pass timestamps.
- `src/app/api/quote/route.ts` BodySchema: `startAt: z.string(), endAt: z.string()` preprocessed via `normalizeTs` then `isoDateTime` (use `z.string().transform(normalizeTs).pipe(isoDateTime)`), while ALSO still accepting legacy keys: add a `.preprocess` that maps `startDate`→`startAt`, `endDate`→`endAt` when present. Same legacy-key preprocess on `POST /api/bookings` (the Phase 1 site posts old field names until the Tex port updates it).
- `src/app/api/admin/planning/route.ts`: `from`/`to` stay `isoDate` (grid is day-indexed; getPlanning converts internally).
- `src/app/api/admin/bookings/route.ts` (manual) + `.../[id]/move/route.ts`: schema fields renamed (`startAt`/`endAt`, `isoDateTime`), with the same legacy-key preprocess so the not-yet-updated board UI keeps working until Task 5 lands (board sends `startDate` today).
- `GET /api/bookings/[id]` response: return `startAt`/`endAt` (confirmation page updated in Task 7).

- [ ] **Step 9: getPlanning day-index conversion**

`src/lib/admin/planning.ts`: query columns rename (`start: bookings.startAt, end: bookings.endAt`); `PlanningBar`/`PlanningBlock` gain the full timestamps AND keep day fields for the (not yet fractional) board:

```ts
export interface PlanningBar {
  id: string;
  start: string;    // local day YYYY-MM-DD the bar starts (derived)
  end: string;      // exclusive local day (derived)
  startAt: string;  // full timestamp
  endAt: string;    // full timestamp
  status: string;
  source: string;
  label: string;
  notes: string | null;
}
```

Derive with `arubaDateOf(startAt)` and, for the exclusive end day, the same `endExclusiveDay` rule from Task 2 Step 6 (00:00 return → that day; otherwise next day). Same for blocks. Blackouts unchanged. The board keeps rendering day-snapped bars after this task; Task 5 makes them fractional using `startAt/endAt`.

- [ ] **Step 10: Settings plumbing**

`src/lib/admin/settings.ts` `SettingsPatchSchema`: replace `turnaroundBufferDays` with `turnaroundBufferHours: z.number().int().min(0).max(168).optional()` and add `openingTime`/`closingTime`: `z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional()` + a merged re-check `openingTime < closingTime`. The settings admin page (`src/app/admin/(shell)/settings/page.tsx`): rename the buffer field label to "Turnaround buffer (hours)" and add two `TimeSelect`s later (Task 4 creates the component; this task may temporarily use text inputs with the same validation to stay green — acceptable ONLY until Task 4 step "settings page TimeSelects" replaces them).

- [ ] **Step 11: Test fixture sweep**

Run: `npm test -- --no-file-parallelism 2>&1 | tail -40` and fix every failure. Mechanical fixture rules: `startDate: "2026-08-01"` → `startAt: atAruba("2026-08-01", "09:00")` (import from `@/lib/time/format` in tests), same for end/buffer; assertions on `rentalDays("2026-08-01", "2026-08-03")` become `rentalDays(atAruba("2026-08-01","09:00"), atAruba("2026-08-03","09:00"))` (same expected values — the ceil math preserves whole-day counts); `validateDates(...)` gains timestamp args + `arubaNowIso()`-style now. Do NOT weaken any assertion; if a test asserted a 2-day price it must still assert a 2-day price.

- [ ] **Step 12: Full verification**

Run: `npm test -- --no-file-parallelism` → expected: ALL green (~199 + the new time tests).
Run: `npx tsc --noEmit` → clean. Run: `npm run lint` → clean.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat(time): timestamptz cutover for bookings, blocks, buffer hours, tstzrange exclusion incl picked_up"
```

---

### Task 3: Business-hours rule + openingTime default at the boundary

**Files:**
- Modify: `src/lib/booking/availability.ts` (validateDates), `src/lib/booking/public.ts` (normalizeTs), `src/app/api/quote/route.ts` + `src/app/api/bookings/route.ts` + `src/app/api/availability/route.ts` + `src/app/api/classes/route.ts` (pass settings into normalize)
- Test: `src/test/business-hours.test.ts`

**Interfaces:**
- Consumes: Task 2 everything.
- Produces: `validateDates` additionally throws unless pickup/return times are within `[openingTime, closingTime]` AND on a 30-minute step; `normalizeTs(value, openingTime)` signature (second param, default "09:00" removed — callers pass `settings.openingTime`). Desk/admin paths (manual booking, move, blocks) deliberately DO NOT get the business-hours check — the desk may hand over a car at 07:00.

- [ ] **Step 1: Failing tests**

Create `src/test/business-hours.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateDates } from "@/lib/booking/availability";
import { atAruba } from "@/lib/time/format";

const settings = { minRentalDays: 1, maxRentalDays: 90, maxAdvanceDays: 365, turnaroundBufferHours: 24, openingTime: "08:00", closingTime: "18:00" };
const now = atAruba("2026-08-01", "10:00");

describe("business hours", () => {
  it("accepts times inside opening hours on 30-minute steps", () => {
    expect(() => validateDates(atAruba("2026-08-02", "08:00"), atAruba("2026-08-03", "17:30"), settings, now)).not.toThrow();
  });
  it("rejects a pickup before opening", () => {
    expect(() => validateDates(atAruba("2026-08-02", "07:30"), atAruba("2026-08-03", "10:00"), settings, now)).toThrow(/between 08:00 and 18:00/);
  });
  it("rejects a return after closing", () => {
    expect(() => validateDates(atAruba("2026-08-02", "09:00"), atAruba("2026-08-03", "18:30"), settings, now)).toThrow(/between 08:00 and 18:00/);
  });
  it("rejects off-step minutes", () => {
    expect(() => validateDates(atAruba("2026-08-02", "09:10"), atAruba("2026-08-03", "10:00"), settings, now)).toThrow(/30 minute/);
  });
});
```

- [ ] **Step 2: Run to fail** — `npm test -- --no-file-parallelism src/test/business-hours.test.ts` → FAIL (validateDates does not yet check hours; DateGuardSettings lacks openingTime).

- [ ] **Step 3: Implement**

In `availability.ts`: extend `DateGuardSettings` with `openingTime: string; closingTime: string;` and append to `validateDates` (after the past check):

```ts
  for (const ts of [startAt, endAt] as const) {
    const hm = arubaTimeOf(ts);
    if (hm < settings.openingTime || hm > settings.closingTime) {
      throw Errors.badRequest(`Pick-up and return must be between ${settings.openingTime} and ${settings.closingTime}`);
    }
    const minutes = Number(hm.slice(3));
    if (minutes % 30 !== 0) throw Errors.badRequest("Times are in 30 minute steps");
  }
```

In `public.ts`: `normalizeTs(value: string, openingTime: string)` uses `openingTime` instead of the hardcoded "09:00"; update the four routes to fetch settings first and pass `settings.openingTime`. Desk/admin schemas are untouched.

- [ ] **Step 4: Run to pass** — the new file green, then the FULL suite: `npm test -- --no-file-parallelism` → green (fixture times of 09:00 are inside defaults).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(time): business hours + 30 minute steps for public pickup/return times"`

---

### Task 4: `TimeSelect` component + wizard step 2 time pickers + settings page time fields

**Files:**
- Create: `src/components/ui/TimeSelect.tsx`, `src/components/ui/time-select.css`
- Modify: `src/components/ui/index.ts` (export), `src/app/(public)/book/page.tsx`, `src/app/(public)/book/book.css` (or the page's CSS file — match where `.fld` styles live), `src/app/admin/(shell)/settings/page.tsx`
- Test: `src/test/time-select.test.tsx` if a component test pattern exists in `src/test/` (check first; if the repo has no React component tests, skip the test file and rely on typecheck + manual verify — do NOT introduce a new test infra)

**Interfaces:**
- Consumes: nothing new.
- Produces: `TimeSelect` with props `{ value: string /* "HH:MM" or "" */, onChange: (v: string) => void, min?: string, max?: string, stepMinutes?: number /* default 30 */, id?: string, ariaLabel?: string, disabled?: boolean }`, exported from `@/components/ui`.

- [ ] **Step 1: Implement `TimeSelect`**

`src/components/ui/TimeSelect.tsx` — a styled `<select>` (keyboard/mobile native, CSP-safe, no popover needed):

```tsx
"use client";

import "./time-select.css";

export interface TimeSelectProps {
  value: string;
  onChange: (v: string) => void;
  min?: string;        // "HH:MM" inclusive
  max?: string;        // "HH:MM" inclusive
  stepMinutes?: number; // default 30
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

function options(min: string, max: string, step: number): string[] {
  const out: string[] = [];
  const [h0, m0] = min.split(":").map(Number);
  const [h1, m1] = max.split(":").map(Number);
  for (let t = h0! * 60 + m0!; t <= h1! * 60 + m1!; t += step) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
  }
  return out;
}

export function TimeSelect({ value, onChange, min = "00:00", max = "23:30", stepMinutes = 30, id, ariaLabel, disabled }: TimeSelectProps) {
  return (
    <select
      className="time-select"
      id={id}
      aria-label={ariaLabel}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="" disabled>Select a time</option>
      {options(min, max, stepMinutes).map((t) => <option key={t} value={t}>{t}</option>)}
    </select>
  );
}
```

`time-select.css`: mirror the DatePicker trigger styling (same border, radius, focus ring, font). Copy the visual tokens from `src/components/ui/date-picker.css` trigger rules; keep it under ~40 lines. Add `export { TimeSelect } from "./TimeSelect";` to `src/components/ui/index.ts`.

- [ ] **Step 2: Wizard step 2 gains times**

In `src/app/(public)/book/page.tsx`: state additions next to line 29-30 (`const [pickup, setPickup] = useState("");`):

```tsx
  const [pickupTime, setPickupTime] = useState("");
  const [retTime, setRetTime] = useState("");
  const [hours, setHours] = useState<{ openingTime: string; closingTime: string }>({ openingTime: "08:00", closingTime: "18:00" });
```

Fetch opening hours once on mount from the quote config the page already loads; if none exists, add a tiny `GET /api/booking-config` consumer ONLY if wave 05 has landed it, otherwise fetch `/api/insurance`-style: the pragmatic v1 is to read them from the first `/api/quote` response error-free path. Decision for THIS task: hardcode the state default to "08:00"/"18:00" and read real values from `quote.meta` if present; wave 05's `/api/booking-config` (which returns openingTime/closingTime too, see its plan) replaces the default when it lands. Keep this as a `// wave-05 wires real hours` comment.

Replace the step 2 card (the exact current JSX, anchor on `{/* ---- Step 2 · Dates ---- */}`):

```tsx
            {/* ---- Step 2 · Dates ---- */}
            {step === 2 && (
              <div className="card">
                <h2 ref={headingRef} tabIndex={-1}><span className="step-n">2</span>Dates</h2>
                <div className="two">
                  <label className="fld">Pick-up date<DatePicker id="pickup" name="pickup" required min={todayISO()} value={pickup} onChange={(iso) => { setPickup(iso); setStepError(""); }} ariaLabel="Pick-up date" /></label>
                  <label className="fld">Pick-up time<TimeSelect id="pickup-time" ariaLabel="Pick-up time" min={hours.openingTime} max={hours.closingTime} value={pickupTime} onChange={(t) => { setPickupTime(t); setStepError(""); }} /></label>
                </div>
                <div className="two">
                  <label className="fld">Return date<DatePicker id="ret" name="ret" required min={pickup || todayISO()} value={ret} onChange={(iso) => { setRet(iso); setStepError(""); }} ariaLabel="Return date" /></label>
                  <label className="fld">Return time<TimeSelect id="ret-time" ariaLabel="Return time" min={hours.openingTime} max={hours.closingTime} value={retTime} onChange={(t) => { setRetTime(t); setStepError(""); }} /></label>
                </div>
                {selectedClass && avail && (avail.available
                  ? <p className="avail ok">✓ A {selectedClass} car is available then</p>
                  : <p className="avail no">✕ {avail.reason}</p>)}
              </div>
            )}
```

Import `TimeSelect` next to `DatePicker` (line 4). Everywhere the page builds `pickup`/`ret` into requests (the `/api/classes` refetch, `/api/quote` POST body, `/api/bookings` POST body, and the `?pickup=` deep-link initializer), compose full timestamps:

```tsx
  const startAt = pickup && pickupTime ? `${pickup}T${pickupTime}:00-04:00` : pickup; // date-only still accepted by the API
  const endAt = ret && retTime ? `${ret}T${retTime}:00-04:00` : ret;
```

and send `startAt`/`endAt` field names (the API keeps the legacy-key preprocess, but this page moves to the new names now). Step-2 advance validation requires all four values; default the two time selects to `hours.openingTime` when the user picked dates via deep link. The review step (step 7) renders `Pick-up {pickup} at {pickupTime}` style lines (final copy polish happens in wave 02's step-7 rebuild; just make times visible here).

- [ ] **Step 3: Settings page time fields**

In `src/app/admin/(shell)/settings/page.tsx`: replace the Task-2 temporary text inputs for `openingTime`/`closingTime` with `TimeSelect` (min "00:00", max "23:30"), labels "Opening time" / "Closing time", saving through the existing `apiPatch` flow.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` → clean. `npm run lint` → clean. `npm test -- --no-file-parallelism` → green.
Manual: `npm run dev` (or the running dev server), open `http://localhost:3000/book?class=Economy`, walk step 2: pick dates + times, watch the class availability + live quote refetch fire; complete a booking end to end against Stripe test keys (redirect appears = enough). Open `/admin/settings`: opening/closing selectable and saving.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(time): TimeSelect + wizard pickup/return times + opening hours settings"`

---

### Task 5: Planning board — fractional bars, time editing, new bar states, timed blocks

**Files:**
- Modify: `src/app/admin/(shell)/page.tsx` (grid math + CreatePanel + move form + legend), `src/app/admin/(shell)/admin.css` or the board's CSS file (locate `.pl-` rules), `src/app/admin/(shell)/fleet/page.tsx` (blocks drawer), the `ServiceModal` in `src/app/admin/(shell)/page.tsx` (lines ~585+)
- Test: `src/test/planning-bars.test.ts` (pure math extracted below)

**Interfaces:**
- Consumes: `PlanningBar.startAt/endAt` from Task 2 Step 9, `TimeSelect` from Task 4, `atAruba/arubaDateOf/arubaTimeOf` from Task 1.
- Produces: `barSpan(days: string[], startAt: string, endAt: string): { left: number; width: number } | null` exported from a NEW pure module `src/lib/admin/bar-span.ts` (board imports it); bar state classifier `barState(bar: { status: string; endAt: string }, nowIso: string): "pending" | "confirmed" | "picked_up" | "due_back_soon" | "overdue" | "completed"` in the same module; CSS classes `.pl-bar--pending|confirmed|picked_up|due-back-soon|overdue|completed`.

- [ ] **Step 1: Failing tests for the pure math**

Create `src/test/planning-bars.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { barSpan, barState } from "@/lib/admin/bar-span";
import { atAruba } from "@/lib/time/format";

const days = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]; // 4 visible columns

describe("barSpan", () => {
  it("positions a 09:00 to 09:00 bar fractionally inside the day columns", () => {
    const s = barSpan(days, atAruba("2026-08-01", "12:00"), atAruba("2026-08-03", "12:00"))!;
    // 12:00 = halfway into day 0 of 4 columns -> left 12.5%; two days wide -> 50%
    expect(s.left).toBeCloseTo(12.5, 5);
    expect(s.width).toBeCloseTo(50, 5);
  });
  it("clamps bars that overflow the visible range", () => {
    const s = barSpan(days, atAruba("2026-07-30", "09:00"), atAruba("2026-08-02", "09:00"))!;
    expect(s.left).toBe(0);
    expect(s.width).toBeGreaterThan(0);
  });
  it("returns null for bars fully outside the range", () => {
    expect(barSpan(days, atAruba("2026-09-01", "09:00"), atAruba("2026-09-02", "09:00"))).toBeNull();
  });
});

describe("barState", () => {
  const now = atAruba("2026-08-02", "10:00");
  it("maps statuses through", () => {
    expect(barState({ status: "pending", endAt: atAruba("2026-08-05", "09:00") }, now)).toBe("pending");
    expect(barState({ status: "completed", endAt: atAruba("2026-08-01", "09:00") }, now)).toBe("completed");
  });
  it("flags picked_up due back within 24h as due_back_soon", () => {
    expect(barState({ status: "picked_up", endAt: atAruba("2026-08-03", "09:00") }, now)).toBe("due_back_soon");
  });
  it("flags picked_up past return as overdue", () => {
    expect(barState({ status: "picked_up", endAt: atAruba("2026-08-02", "09:00") }, now)).toBe("overdue");
  });
  it("keeps a comfortable picked_up as picked_up", () => {
    expect(barState({ status: "picked_up", endAt: atAruba("2026-08-04", "09:00") }, now)).toBe("picked_up");
  });
});
```

- [ ] **Step 2: Run to fail** — `npm test -- --no-file-parallelism src/test/planning-bars.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/admin/bar-span.ts`**

```ts
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
```

- [ ] **Step 4: Run to pass** — `npm test -- --no-file-parallelism src/test/planning-bars.test.ts` → PASS.

- [ ] **Step 5: Wire the board**

In `src/app/admin/(shell)/page.tsx` (read the whole file first — it is ~646 lines):

1. Replace the internal `span()` math with `barSpan(days, b.startAt, b.endAt)` for booking bars and `barSpan(days, bl.startAt, bl.endAt)` for block bars (blackouts keep the existing day-snapped span over their date fields).
2. Bar `className` gains the state: `` `pl-bar pl-bar--${barState(b, nowIso)}` `` where `nowIso` comes from `arubaNowIso()` once per render. Bar title/tooltip shows `formatTime(b.startAt)}–${formatTime(b.endAt)}` — use "to" not an en dash: `${formatTime(b.startAt)} to ${formatTime(b.endAt)}`.
3. Drag-create still snaps to whole days (`dayAt` unchanged); the CreatePanel it opens now shows two `TimeSelect`s (pickup time, return time) defaulted to "09:00", posts `startAt/endAt` composed with `atAruba(...)`. Drag-move keeps each bar's original times: on drop, compose the new dates with the bar's existing `arubaTimeOf(startAt)`/`arubaTimeOf(endAt)` and PATCH `{ startAt, endAt, vehicleId }` to the move route.
4. The move/detail popover (BookingPanel) gains read-only time display; full time editing lives in the CreatePanel + move form `TimeSelect`s.
5. `ServiceModal` (block creation) gains two `TimeSelect`s (default "00:00" start, "00:00" end meaning full days — note in the label "leave 00:00 for full days") and posts `startAt/endAt`; the blocks routes' zod schemas rename to `startAt/endAt: isoDateTime` with the legacy-key preprocess. Same for the Fleet page blocks drawer.
6. Legend (`.pl-legend`, line ~242): entries for Pending, Confirmed, Checked out (label it "Checked in" from the desk's perspective: use "With customer"), Due back soon, Overdue, Completed, Blocked. CSS in the board stylesheet:

```css
.pl-bar--pending { background: #C98A33; }
.pl-bar--confirmed { background: #0E3A40; }
.pl-bar--picked_up { background: #2C5F8A; }
.pl-bar--due-back-soon { background: #2C5F8A; outline: 2px solid #C98A33; outline-offset: -2px; }
.pl-bar--overdue { background: #8A2C2C; }
.pl-bar--completed { background: #2E7D5B; }
```

(These sit inside the Sand & Surf range; keep the existing blocked style. If the file uses CSS variables for the old colors, extend the variable block instead of hardcoding.)

- [ ] **Step 6: Verify**

`npx tsc --noEmit` + `npm run lint` clean; full suite green. Manual: on the dev server open `/admin`, confirm: a 12:00 return bar visibly ends mid-column; drag-create opens the panel with time selects; a manual booking with times renders fractionally; ServiceModal creates a timed block; legend shows the six states.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(board): fractional time bars, bar states, timed blocks and time editing"`

---

### Task 6: Desk conflict warnings — manual bookings and moves check blocks/blackouts

**Files:**
- Modify: `src/lib/admin/manual-booking.ts`, `src/lib/admin/move-booking.ts`, `src/app/api/admin/bookings/route.ts`, `src/app/api/admin/bookings/[id]/move/route.ts`, `src/app/admin/(shell)/page.tsx` (CreatePanel + move flow)
- Test: `src/test/desk-conflicts.test.ts`

**Interfaces:**
- Consumes: `checkAvailability` (Task 2).
- Produces: both libs accept `{ override?: boolean }`; without it, a block/blackout collision throws `Errors.conflict` with `code: "advisory_conflict"` in the payload (shape: the existing `Errors.conflict(message)` extended by passing `Errors.conflict(message, { code: "advisory_conflict" })` — check `src/lib/http/errors.ts` for the exact constructor; if it takes only a message, add an optional `details` object to it, additive). The UI turns a 409 with `code === "advisory_conflict"` into a confirm dialog and retries with `override: true`.

- [ ] **Step 1: Failing tests**

Create `src/test/desk-conflicts.test.ts` — seed a vehicle with an availability block, then:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createManualBooking } from "@/lib/admin/manual-booking";
import { atAruba } from "@/lib/time/format";
// Use the repo's existing test DB bootstrap pattern: open src/test/ and copy the
// setup used by the manual-booking or availability tests (seed helpers, getDb).

describe("desk advisory conflicts", () => {
  // beforeAll: create vehicle V, block V from 2026-08-10T00:00-04:00 to 2026-08-12T00:00-04:00 (existing seed helpers)
  it("rejects a manual booking over a block without override", async () => {
    await expect(createManualBooking({
      vehicleId: V.id, startAt: atAruba("2026-08-10", "09:00"), endAt: atAruba("2026-08-11", "09:00"),
      customerName: "Desk Test",
    })).rejects.toMatchObject({ status: 409 });
  });
  it("allows the same booking with override: true", async () => {
    const b = await createManualBooking({
      vehicleId: V.id, startAt: atAruba("2026-08-10", "09:00"), endAt: atAruba("2026-08-11", "09:00"),
      customerName: "Desk Test", override: true,
    });
    expect(b.status).toBe("confirmed");
  });
});
```

(Adapt the seeding to the repo's existing test-fixture helpers — the availability tests already create vehicles + blocks; reuse those helpers verbatim.)

- [ ] **Step 2: Run to fail** — the first case fails today because `createManualBooking` skips the advisory check entirely (no 409 without a real booking collision).

- [ ] **Step 3: Implement**

`manual-booking.ts`: add `override: z.boolean().default(false)` to the schema; after resolving the vehicle:

```ts
  if (!input.override) {
    const availability = await checkAvailability(vehicle.id, input.startAt, input.endAt, settings);
    // A booking clash is already surfaced by the DB constraint on insert; the
    // advisory value here is blocks and blackouts, which the constraint can't see.
    if (!availability.available) {
      throw Errors.conflict(`${availability.reason ?? "That range is unavailable"}. Confirm to book anyway.`, { code: "advisory_conflict" });
    }
  }
```

Same guard in `moveBooking` (inside the transaction, before the update; exclude the booking's own row — `checkAvailability` counts the moving booking itself, so either pass an `excludeBookingId` option through to the clash query (add the optional param, `ne(bookings.id, excludeBookingId)`) or run only the block/blackout parts for moves; implement the `excludeBookingId` option, it is 4 lines and also fixes same-car date tweaks). Route schemas accept `override`. If `Errors.conflict` has no details param, extend it additively in `src/lib/http/errors.ts` and include `code` in the JSON error body.

`CreatePanel` and the drag-move handler in the board: on a 409 whose body has `code === "advisory_conflict"`, `await confirm({ title: "Car unavailable", message: err.message, confirmLabel: "Book anyway", danger: true })` and retry with `override: true`.

- [ ] **Step 4: Run to pass** — new file green; full suite green.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(desk): advisory block/blackout conflicts with explicit override on manual bookings and moves"`

---

### Task 7: Display sweep — emails, confirmation, account, checkout description

**Files:**
- Modify: `src/lib/email/templates.ts`, `src/lib/email/notifications.ts`, `src/app/(public)/book/confirmation/page.tsx`, `src/app/(public)/account/page.tsx`, `src/lib/payments/checkout.ts`
- Test: `src/test/email-templates.test.ts` (extend existing)

**Interfaces:**
- Consumes: `formatDateTime` (Task 1).
- Produces: every customer/admin-facing rendering of a rental period shows "Aug 1, 2026 at 09:00 to Aug 3, 2026 at 09:00" via `formatDateTime`. No raw ISO strings or bare dates remain for booking periods.

- [ ] **Step 1: Extend the template tests** — in `src/test/email-templates.test.ts`, update period assertions to expect `formatDateTime` output (e.g. `expect(html).toContain("Aug 1, 2026 at 09:00")`) for `bookingConfirmedEmail`, `bookingCancelledEmail`, `adminNewBookingEmail`, `adminPaymentEmail`. Run to fail.
- [ ] **Step 2: Implement** — template functions take the booking's `startAt/endAt` and render via `formatDateTime`; `notifications.ts` passes them through; confirmation + account pages render the same; `checkout.ts` line description per Task 2 Step 7 rule 9 (verify done, else do it here).
- [ ] **Step 3: Run to pass** — file green, full suite green, `npx tsc --noEmit` clean.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(time): human wall-time rendering across emails, confirmation, account, Stripe line"`

---

### Task 8: Wave-01 final verification

**Files:** none new.

- [ ] Full suite: `npm test -- --no-file-parallelism` → all green.
- [ ] `npx tsc --noEmit` and `npm run lint` → clean.
- [ ] Stop any dev server, `rm -rf .next`, `npm run build` → succeeds. Restart dev after.
- [ ] Manual smoke (dev server):
  1. `/book` end to end with times → Stripe test redirect → confirmation shows "at HH:MM".
  2. `/book?class=Economy&pickup=2026-08-20&return=2026-08-22` (date-only deep link) still works, defaults to opening time.
  3. `/admin` board: fractional bars, states legend, drag-create with times, timed block via ServiceModal, drag-move preserves times, block collision asks "Book anyway".
  4. `/admin/settings`: buffer hours + opening/closing times save and are enforced on the public wizard.
- [ ] Commit any smoke fixes with `fix(...)` messages; done.
