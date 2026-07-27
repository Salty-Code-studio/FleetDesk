# Reports Upgrade Implementation Plan (Wave 07)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the owner a per-car, per-month revenue matrix with yearly totals, a borg (security deposit) panel that is kept strictly out of revenue, and downloadable Sand & Surf styled monthly and yearly revenue PDFs.

**Architecture:** A new `perCarRevenue(year)` aggregator in `src/lib/admin/reports.ts` slices each booking's snapshotted rental subtotal across months by overlap days (Aruba local), exposed via `GET /api/admin/reports/per-car`. A new `src/lib/pdf/report.tsx` renders monthly and yearly PDFs with `@react-pdf/renderer` (dependency already introduced by the check-in plan), served on demand by `GET /api/admin/reports/pdf`. The `/admin/reports` page gains the matrix table, a year selector, the borg panel, and Download PDF buttons.

**Tech Stack:** Next.js 15 (App Router, nodejs runtime routes), Drizzle ORM (PGlite dev/test, Supabase Postgres prod), zod at every boundary, vitest, `@react-pdf/renderer`, Sand & Surf admin kit.

## Global Constraints

- Tests: `npm test -- --no-file-parallelism` (vitest). New features land with tests.
- NEVER `npm run build` while a `next dev` server is running (shared `.next` corrupts).
- Migrations: `npm run db:generate` for drizzle diffs; hand-written SQL files in `./drizzle` for constraints/enum surgery (precedent: 0002, 0007, 0010). Applied with `npm run db:migrate`. Must work on BOTH PGlite (`pglite://`, dev/test) and Postgres (Supabase prod).
- Admin mutations go through `mutate(req, action, fn)` from `src/lib/admin/guard.ts` (audit-logged); reads through `read(req, fn)`.
- Admin UI: reuse `Modal, Drawer, useToast, useConfirm, Skeleton, EmptyState, registerPaletteAction` from `@/app/admin/_ui` and `DatePicker, Select` from `@/components/ui`. Strict CSP: no external assets ever. Money is integer cents.
- Copy: dash-free house style (no em-dashes), warm/human tone.
- Timezone: operator-local day logic uses `America/Aruba` (existing `arubaToday()` precedent).
- Design principle: less clicking. One click from a planning bar opens the BookingDrawer with everything in it.

Workstream-specific constraints (spec Workstream 7):

- Revenue figures count rental income ONLY: `priceBreakdown.subtotalCents` snapshots (vehicle + insurance + extras + surcharges). Security deposits (borg) are never revenue.
- Historical pre-wave `full_deposit` Stripe charges are excluded from revenue. This plan enforces it structurally: revenue math never reads the `payments` table, and a test proves a deposit-type payment row changes nothing.
- Borg panel data comes from the `inspections` checklist fields (plan 06): held at pickup, returned, withheld with amounts and reasons.
- PDF export is generated on demand by an admin API route (no storage), Sand & Surf styled, filenames `revenue-YYYY.pdf` and `revenue-YYYY-MM.pdf`.
- This plan adds NO migrations and NO new dependencies (`@react-pdf/renderer` is introduced by plan 06; this plan only reuses it).

## Codebase state assumed when this plan runs (plans 01 through 06 merged)

Implementers see only their own task plus the seams doc (`docs/superpowers/plans/SEAMS-2026-07-wave.md`), so the relevant post-plan-01..06 facts are restated here:

- `bookings` columns are timestamptz: drizzle properties `startAt` (`start_at`), `endAt` (`end_at`), `bufferEndAt` (`buffer_end_at`), semantics `[startAt, endAt)`. Drizzle `timestamp(..., { withTimezone: true })` columns in this repo use Date mode: insert `new Date(...)`, select returns `Date`.
- `booking_status` enum is `pending | confirmed | picked_up | completed | cancelled`. The overlap exclusion constraint covers `pending`, `confirmed`, `picked_up` (so test seed bookings in those statuses must not overlap per vehicle; `completed` and `cancelled` are exempt).
- Timestamp columns use drizzle `mode: "string"` (plan 01 decision): INSERT ISO strings (`atAruba(...)` from `@/lib/time/format` or `new Date(x).toISOString()`), never `Date` objects; parse reads with `parseTs` before numeric math. Adapt any `startAt: new Date(...)` fixture lines below accordingly; check `src/lib/db/schema/bookings.ts` first.
- `payment_option` enum is `deposit | full`. `payment_type` enum is `reservation_fee | deposit | extension`. `payments` has a `method` column defaulting to `'stripe'`.
- `inspections` table exists (plan 06) with drizzle properties per the seams doc: `id`, `bookingId`, `kind` (`'pickup' | 'return'`), `odometer`, `fuelLevel`, `notes`, `photos` (jsonb `[{key, label}]`), `licensePhotoKey`, `signatureKey`, `contractPdfKey`, `damageFlags` (jsonb `[{photoKey, note}]`), `acceptedPolicyVersion`, `agreementSigned`, `rulesSigned`, `licenseCopyReceived`, `borgReceivedCents`, `borgMethod`, `borgReturnedCents`, `borgWithheldCents`, `borgWithheldReason`, `keysReturned`, `createdBy` (FK to admin_users), `createdAt`. Exported from `@/lib/db/schema` as `inspections`.
- `@react-pdf/renderer` is in `package.json` (plan 06) and `src/lib/pdf/contract.tsx` exists. This plan adds the sibling `src/lib/pdf/report.tsx`.
- `src/lib/site-config.ts` exists (plan 02) exposing the seam names `siteName`, `siteUrl`, `backLinkLabel` read from env. This plan consumes `siteName` for the PDF header. If plan 02 shipped them wrapped in a single exported object instead of named exports, import that object and read its `siteName` property; the seam name is `siteName` either way.
- `src/lib/admin/reports.ts` still exports `getReports(today: string)` with the module-level helpers `addDays`, `monthOffset`, `overlapDays` and the constants `REVENUE_STATUSES` / `OCCUPANCY_STATUSES` (pre-wave lines 30-42). Plan 01 rewrote its date reads to the timestamp columns; the constant and helper NAMES are stable anchors even if line numbers moved.

Line anchors below reference the pre-wave files; if earlier wave plans shifted lines, anchor on the quoted code instead.

---

### Task 1: `perCarRevenue(year)` aggregator + revenue status reconciliation in `src/lib/admin/reports.ts`

**Files:**
- Modify: `src/lib/admin/reports.ts` (pre-wave anchors: imports at lines 8-11, `REVENUE_STATUSES`/`OCCUPANCY_STATUSES` at lines 30-31, the `inArray` status filter at line 57, the `activeRentals` filter at line 68; append the new code at end of file)
- Test: `src/test/admin-reports-percar.test.ts` (new)

**Interfaces:**
- Consumes: `bookings.startAt/endAt/priceBreakdown/status` and `inspections.*` drizzle properties as listed in "Codebase state assumed" above; existing module-level helpers `addDays(d: string, n: number): string` and `overlapDays(s: string, e: string, winStart: string, winEnd: string): number` in `src/lib/admin/reports.ts`; `getDb()` from `@/lib/db/client`.
- Produces (seam `Reports (plan 07)` in the seams doc): `perCarRevenue(year: number): Promise<PerCarRevenueReport>` exported from `src/lib/admin/reports.ts`, where `PerCarRevenueReport` is `{ year: number, months: string[], rows: { vehicleId: string, name: string, plate: string, class: string, monthCents: number[], totalCents: number }[], grandTotalCents: number, borg: { heldCents: number, returnedCents: number, withheldCents: number, withheldCount: number, withheldItems: { plate: string, name: string, amountCents: number, reason: string }[] } }`. All seam field names are verbatim; `borg.withheldItems` is a plan-07 additive extension (the spec requires withheld amounts WITH reasons) consumed only by this plan's UI and PDF.
- Also produces: `getReports` now counts `picked_up` bookings as revenue and occupancy (Tasks 2-5 and the reports page rely on the same status semantics).

**Month attribution rule (implement exactly this):** a booking's revenue weight is its span in Aruba-local calendar days, `[arubaDay(startAt), arubaDay(endAt))`; if that span is empty (sub-24h rental) it counts as 1 day. Each month of the target year receives `subtotalCents × (overlap days in month / total span days)`, allocated cumulatively (each month's cell is `round(subtotal × cumulativeDays/totalDays) − allocatedSoFar`) so rounding never drifts: a fully-in-year booking's cells sum exactly to its subtotal, and a year-spanning booking contributes only its in-year fraction.

**Steps:**

- [ ] Write the failing test. Create `src/test/admin-reports-percar.test.ts` with exactly:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, payments, adminUsers, inspections } from "@/lib/db/schema";
import { perCarRevenue, getReports } from "@/lib/admin/reports";

let db: Awaited<ReturnType<typeof getDb>>;
let ecoId: string, suvId: string, van1Id: string;
let customerId: string;
let adminId: string;

type BookingStatus = "pending" | "confirmed" | "picked_up" | "completed" | "cancelled";

/** Insert a booking with a snapshot subtotal. bufferEndAt = endAt is fine for
 *  the buffer check; seeded pending/confirmed/picked_up spans never overlap
 *  per vehicle, so the exclusion constraint stays quiet. */
async function addBooking(
  vehicleId: string, startAt: string, endAt: string,
  subtotalCents: number, status: BookingStatus, key: string,
) {
  const [row] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt: new Date(startAt), endAt: new Date(endAt), bufferEndAt: new Date(endAt),
    status, priceBreakdown: { subtotalCents }, paymentOption: "deposit",
    acceptedPolicyVersion: 1, acceptedAt: new Date(), idempotencyKey: key,
  }).returning();
  return row!;
}

const car = (slug: string, cls: string, name: string, status: "active" | "retired" = "active") => ({
  slug, plate: `RPT-${slug}`, class: cls, name, seats: 4, transmission: "Automatic",
  doors: 4, priceDayCents: 4000, priceWeekCents: 24000, priceMonthCents: 80000, status,
});

beforeAll(async () => {
  db = await getDb();
  await runMigrations();

  const [eco] = await db.insert(vehicles).values(car("eco", "Economy", "Report Eco")).returning();
  await db.insert(vehicles).values(car("cmp", "Compact", "Report Compact"));
  const [suv] = await db.insert(vehicles).values(car("suv", "SUV", "Report SUV")).returning();
  const [van1] = await db.insert(vehicles).values(car("van1", "Van", "Report Van", "retired")).returning();
  await db.insert(vehicles).values(car("van2", "Van", "Idle Retired Van", "retired"));
  ecoId = eco!.id; suvId = suv!.id; van1Id = van1!.id;

  const [c] = await db.insert(customers).values({ email: "reports@test.com", name: "Report Renter" }).returning();
  customerId = c!.id;
  const [admin] = await db.insert(adminUsers).values({ email: "reports-admin@test.com", passwordHash: "x" }).returning();
  adminId = admin!.id;

  // Economy: cross-month completed rental, a picked_up rental, and two rows
  // that must never count (pending, cancelled). Times are Aruba local (-04:00).
  const b1 = await addBooking(ecoId, "2026-03-28T09:00:00-04:00", "2026-04-04T09:00:00-04:00", 70000, "completed", "rpt-b1");
  const b2 = await addBooking(ecoId, "2026-06-10T09:00:00-04:00", "2026-06-13T09:00:00-04:00", 30000, "picked_up", "rpt-b2");
  await addBooking(ecoId, "2026-07-01T09:00:00-04:00", "2026-07-03T09:00:00-04:00", 99999, "pending", "rpt-b3");
  await addBooking(ecoId, "2026-08-01T09:00:00-04:00", "2026-08-03T09:00:00-04:00", 88888, "cancelled", "rpt-b4");

  // SUV: a rounding split, a rental spanning New Year, and a sub-24h rental.
  await addBooking(suvId, "2026-03-31T09:00:00-04:00", "2026-04-02T09:00:00-04:00", 1001, "completed", "rpt-b5");
  const b6 = await addBooking(suvId, "2025-12-30T09:00:00-04:00", "2026-01-03T09:00:00-04:00", 40000, "completed", "rpt-b6");
  await addBooking(suvId, "2026-06-20T09:00:00-04:00", "2026-06-20T12:00:00-04:00", 5000, "completed", "rpt-b7");

  // A retired car with in-year history stays visible in the report.
  await addBooking(van1Id, "2026-02-10T09:00:00-04:00", "2026-02-12T09:00:00-04:00", 15000, "completed", "rpt-b8");

  // A historical pre-wave security-deposit charge captured via Stripe.
  // Revenue math must never read payment rows, so this changes nothing.
  await db.insert(payments).values({
    bookingId: b1.id, type: "deposit", amountCents: 100000, status: "succeeded",
  });

  // Borg lifecycle from inspections. B1: 50000 held at pickup, 30000 returned
  // and 20000 withheld at return. B2: 50000 held. B6: held in 2025 (out of year).
  await db.insert(inspections).values({
    bookingId: b1.id, kind: "pickup", createdBy: adminId,
    createdAt: new Date("2026-03-28T14:00:00-04:00"),
    borgReceivedCents: 50000, photos: [], damageFlags: [],
  });
  await db.insert(inspections).values({
    bookingId: b1.id, kind: "return", createdBy: adminId,
    createdAt: new Date("2026-04-04T13:00:00-04:00"),
    borgReturnedCents: 30000, borgWithheldCents: 20000,
    borgWithheldReason: "Scratched rear bumper", photos: [], damageFlags: [],
  });
  await db.insert(inspections).values({
    bookingId: b2.id, kind: "pickup", createdBy: adminId,
    createdAt: new Date("2026-06-10T13:00:00-04:00"),
    borgReceivedCents: 50000, photos: [], damageFlags: [],
  });
  await db.insert(inspections).values({
    bookingId: b6.id, kind: "pickup", createdBy: adminId,
    createdAt: new Date("2025-12-30T13:00:00-04:00"),
    borgReceivedCents: 40000, photos: [], damageFlags: [],
  });
});

describe("perCarRevenue", () => {
  it("builds the 12 month keys of the requested year", async () => {
    const r = await perCarRevenue(2026);
    expect(r.year).toBe(2026);
    expect(r.months).toEqual([
      "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
      "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12",
    ]);
  });

  it("slices a cross-month booking by overlap days and counts picked_up rentals", async () => {
    const r = await perCarRevenue(2026);
    const eco = r.rows.find((row) => row.plate === "RPT-eco")!;
    // Mar 28..31 = 4 of 7 days -> 40000; Apr 1..3 = 3 of 7 days -> 30000.
    // June: the picked_up rental, 3 fully-in-June days -> 30000.
    expect(eco.monthCents).toEqual([0, 0, 40000, 30000, 0, 30000, 0, 0, 0, 0, 0, 0]);
    // Pending, cancelled, and the deposit payment row never count.
    expect(eco.totalCents).toBe(100000);
  });

  it("allocates rounding without drift so cells sum exactly to the subtotal", async () => {
    const r = await perCarRevenue(2026);
    const suv = r.rows.find((row) => row.plate === "RPT-suv")!;
    expect(suv.monthCents[2]).toBe(501); // Mar: round(1001 x 1/2)
    expect(suv.monthCents[3]).toBe(500); // Apr: remainder; 501 + 500 = 1001
  });

  it("attributes only the in-year days of a booking that spans New Year", async () => {
    const r = await perCarRevenue(2026);
    const suv = r.rows.find((row) => row.plate === "RPT-suv")!;
    expect(suv.monthCents[0]).toBe(20000); // Jan 1 + Jan 2 of a 4 day rental at 40000
  });

  it("treats a sub-24h rental as one day", async () => {
    const r = await perCarRevenue(2026);
    const suv = r.rows.find((row) => row.plate === "RPT-suv")!;
    expect(suv.monthCents[5]).toBe(5000);
    expect(suv.totalCents).toBe(26001); // 20000 + 501 + 500 + 5000
  });

  it("groups rows by class order, keeps zero-revenue active cars, hides zero-revenue retired cars", async () => {
    const r = await perCarRevenue(2026);
    // Economy, Compact, SUV, Van; RPT-van2 (retired, no history) is hidden.
    expect(r.rows.map((row) => row.plate)).toEqual(["RPT-eco", "RPT-cmp", "RPT-suv", "RPT-van1"]);
    const cmp = r.rows.find((row) => row.plate === "RPT-cmp")!;
    expect(cmp.totalCents).toBe(0);
    expect(cmp.monthCents).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("sums row totals into the grand total", async () => {
    const r = await perCarRevenue(2026);
    expect(r.grandTotalCents).toBe(141001); // 100000 + 0 + 26001 + 15000
    expect(r.grandTotalCents).toBe(r.rows.reduce((s, row) => s + row.totalCents, 0));
  });

  it("reports borg held, returned, and withheld for the year, separate from revenue", async () => {
    const r = await perCarRevenue(2026);
    expect(r.borg.heldCents).toBe(100000); // the 2025 pickup is excluded
    expect(r.borg.returnedCents).toBe(30000);
    expect(r.borg.withheldCents).toBe(20000);
    expect(r.borg.withheldCount).toBe(1);
    expect(r.borg.withheldItems).toEqual([
      { plate: "RPT-eco", name: "Report Eco", amountCents: 20000, reason: "Scratched rear bumper" },
    ]);
  });

  it("returns zero rows and a zero borg summary for a year with no activity", async () => {
    const r = await perCarRevenue(2019);
    expect(r.rows.map((row) => row.plate)).toEqual(["RPT-eco", "RPT-cmp", "RPT-suv"]);
    expect(r.grandTotalCents).toBe(0);
    expect(r.borg).toEqual({ heldCents: 0, returnedCents: 0, withheldCents: 0, withheldCount: 0, withheldItems: [] });
  });
});

describe("getReports revenue statuses", () => {
  it("counts picked_up rentals in all-time revenue", async () => {
    const r = await getReports("2026-06-15");
    expect(r.kpis.revenueAllCents).toBe(161001); // 70000+30000+1001+40000+5000+15000
  });
});
```

- [ ] Run the test to verify it fails: `npm test -- --no-file-parallelism src/test/admin-reports-percar.test.ts`. Expected: the file errors at collection with `SyntaxError: The requested module '/src/lib/admin/reports.ts' does not provide an export named 'perCarRevenue'` (or an equivalent missing-export failure). If instead it fails on an `inspections` import, STOP: plan 06 has not been merged yet; this plan depends on it.
- [ ] Update the status constants in `src/lib/admin/reports.ts`. A car that is out (`picked_up`) is earning revenue and occupying the fleet. Change the two constants (pre-wave lines 30-31) to exactly:

```ts
const REVENUE_STATUSES = ["confirmed", "picked_up", "completed"] as const;
const OCCUPANCY_STATUSES = ["pending", "confirmed", "picked_up"] as const;
```

If plan 06 already made this exact change, verify it matches and move on.
- [ ] In `getReports`, widen the fetched status list (pre-wave line 57). The `.where(...)` on the bookings select must read exactly:

```ts
.where(inArray(bookings.status, ["pending", "confirmed", "picked_up", "completed"]))
```

- [ ] In `getReports`, count `picked_up` in the "out on rental now" KPI (pre-wave line 68). Wherever the `activeRentals` filter tests `b.status === "confirmed"`, change that status test to `(b.status === "confirmed" || b.status === "picked_up")`, keeping the surrounding date comparison exactly as plan 01 left it. If plan 06 already made this exact change, verify and move on.
- [ ] Extend the imports at the top of `src/lib/admin/reports.ts`: the drizzle-orm import must include `eq` and the schema import must include `inspections`:

```ts
import { inArray, eq } from "drizzle-orm";
import { vehicles, bookings, inspections } from "@/lib/db/schema";
```

(Keep any additional names earlier plans added to these imports.)
- [ ] Append the implementation at the end of `src/lib/admin/reports.ts`:

```ts
/* ---------------------------------------------------------------------------
 * Per-car revenue matrix (wave 07). Rows = vehicles grouped by class, columns
 * = the 12 months of `year`. A booking's snapshot subtotal is sliced across
 * months by overlap DAYS (Aruba local), allocated cumulatively so rounding
 * never drifts: a fully-in-year booking's cells sum exactly to its subtotal.
 * Revenue = rental income snapshots only; payment rows (including historical
 * pre-wave deposit charges) are never read. The borg summary reports security
 * deposits separately because deposits are held money, never revenue.
 * ------------------------------------------------------------------------- */

export interface PerCarRow {
  vehicleId: string;
  name: string;
  plate: string;
  class: string;
  monthCents: number[]; // 12 entries, January first
  totalCents: number;
}

export interface BorgWithheldItem {
  plate: string;
  name: string;
  amountCents: number;
  reason: string;
}

export interface PerCarRevenueReport {
  year: number;
  months: string[]; // ["YYYY-01", ..., "YYYY-12"]
  rows: PerCarRow[];
  grandTotalCents: number;
  borg: {
    heldCents: number;
    returnedCents: number;
    withheldCents: number;
    withheldCount: number;
    withheldItems: BorgWithheldItem[]; // additive plan-07 field (spec: withheld amounts WITH reasons)
  };
}

/** Fleet grouping order for report rows. Kept module-local on purpose: the
 *  seams doc defines no shared CLASS_ORDER export and plan 04 groups the fleet
 *  page with its own copy. Unknown classes sort last, then by plate. */
const REPORT_CLASS_ORDER = ["Economy", "Compact", "SUV", "4x4", "Van"];

/** The calendar day of a timestamp where the business operates (America/Aruba). */
const arubaDay = (d: Date | string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Aruba" }).format(new Date(d));

export async function perCarRevenue(year: number): Promise<PerCarRevenueReport> {
  const db = await getDb();

  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const monthStarts = months.map((mk) => `${mk}-01`);
  const monthEnds = months.map((_, i) =>
    i === 11 ? `${year + 1}-01-01` : `${year}-${String(i + 2).padStart(2, "0")}-01`);

  const vrows = await db.select({
    id: vehicles.id, plate: vehicles.plate, name: vehicles.name, class: vehicles.class, status: vehicles.status,
  }).from(vehicles);
  const vById = new Map(vrows.map((v) => [v.id, v]));

  const brows = await db.select({
    vehicleId: bookings.vehicleId, startAt: bookings.startAt, endAt: bookings.endAt,
    priceBreakdown: bookings.priceBreakdown,
  }).from(bookings).where(inArray(bookings.status, ["confirmed", "picked_up", "completed"]));

  const cells = new Map<string, number[]>();
  for (const b of brows) {
    const subtotal = Number((b.priceBreakdown as { subtotalCents?: number } | null)?.subtotalCents ?? 0);
    if (subtotal <= 0) continue;
    const startDay = arubaDay(b.startAt);
    let endDay = arubaDay(b.endAt);
    if (endDay <= startDay) endDay = addDays(startDay, 1); // sub-24h rental = one day
    const totalDays = Math.round((Date.parse(`${endDay}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`)) / 86_400_000);

    let arr = cells.get(b.vehicleId);
    if (!arr) { arr = new Array<number>(12).fill(0); cells.set(b.vehicleId, arr); }
    let cumDays = 0;
    let allocated = 0;
    for (let m = 0; m < 12; m++) {
      cumDays += overlapDays(startDay, endDay, monthStarts[m]!, monthEnds[m]!);
      const target = Math.round((subtotal * cumDays) / totalDays);
      arr[m] = arr[m]! + (target - allocated);
      allocated = target;
    }
  }

  const rows: PerCarRow[] = vrows
    .filter((v) => v.status !== "retired" || (cells.get(v.id)?.some((c) => c > 0) ?? false))
    .map((v) => {
      const monthCents = cells.get(v.id) ?? new Array<number>(12).fill(0);
      return {
        vehicleId: v.id, name: v.name, plate: v.plate, class: v.class,
        monthCents, totalCents: monthCents.reduce((s, c) => s + c, 0),
      };
    })
    .sort((a, b) => {
      const ia = REPORT_CLASS_ORDER.indexOf(a.class), ib = REPORT_CLASS_ORDER.indexOf(b.class);
      const d = (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return d !== 0 ? d : a.plate.localeCompare(b.plate);
    });
  const grandTotalCents = rows.reduce((s, r) => s + r.totalCents, 0);

  // Borg (security deposits) from check-in / check-out inspections this year.
  const irows = await db.select({
    kind: inspections.kind,
    createdAt: inspections.createdAt,
    borgReceivedCents: inspections.borgReceivedCents,
    borgReturnedCents: inspections.borgReturnedCents,
    borgWithheldCents: inspections.borgWithheldCents,
    borgWithheldReason: inspections.borgWithheldReason,
    vehicleId: bookings.vehicleId,
  }).from(inspections).innerJoin(bookings, eq(inspections.bookingId, bookings.id));

  let heldCents = 0, returnedCents = 0, withheldCents = 0, withheldCount = 0;
  const withheldItems: BorgWithheldItem[] = [];
  for (const insp of irows) {
    if (arubaDay(insp.createdAt).slice(0, 4) !== String(year)) continue;
    if (insp.kind === "pickup") {
      heldCents += insp.borgReceivedCents ?? 0;
    } else {
      returnedCents += insp.borgReturnedCents ?? 0;
      const w = insp.borgWithheldCents ?? 0;
      if (w > 0) {
        withheldCents += w;
        withheldCount += 1;
        const v = vById.get(insp.vehicleId);
        withheldItems.push({
          plate: v?.plate ?? "?", name: v?.name ?? "?",
          amountCents: w, reason: insp.borgWithheldReason ?? "",
        });
      }
    }
  }

  return { year, months, rows, grandTotalCents, borg: { heldCents, returnedCents, withheldCents, withheldCount, withheldItems } };
}
```

- [ ] Run the test to verify it passes: `npm test -- --no-file-parallelism src/test/admin-reports-percar.test.ts`. Expected: `Test Files  1 passed`, `Tests  10 passed`.
- [ ] Run the whole suite to catch regressions in `getReports` consumers: `npm test -- --no-file-parallelism`. Expected: all test files pass (some earlier-wave counts plus these 10).
- [ ] Typecheck: `npx tsc --noEmit`. Expected: no output.
- [ ] Commit: `git add src/lib/admin/reports.ts src/test/admin-reports-percar.test.ts && git commit -m "feat(reports): per-car monthly revenue matrix with borg summary, count picked_up as revenue"`

---
### Task 2: `GET /api/admin/reports/per-car` route

**Files:**
- Create: `src/app/api/admin/reports/per-car/route.ts`

**Interfaces:**
- Consumes: `perCarRevenue(year: number): Promise<PerCarRevenueReport>` from `@/lib/admin/reports` (Task 1); `withRoute` from `@/lib/http/handler`; `json` from `@/lib/http/respond`; `parseParams` from `@/lib/http/validate`; `read` from `@/lib/admin/guard` (owner-only by default, which is correct: the spec's staff plan keeps reports owner-only); `arubaToday()` from `@/lib/booking/public`.
- Produces (seam): `GET /api/admin/reports/per-car?year=YYYY` returning the `PerCarRevenueReport` JSON `{ year, months, rows: [{vehicleId, name, plate, class, monthCents, totalCents}], grandTotalCents, borg: { heldCents, returnedCents, withheldCents, withheldCount, withheldItems } }`. `year` defaults to the current Aruba year when omitted. Task 5's page fetches this.

This is a thin wrapper in the exact shape of the existing `src/app/api/admin/reports/route.ts` (which has no route-level test either); the logic underneath is fully covered by Task 1's tests.

**Steps:**

- [ ] Create `src/app/api/admin/reports/per-car/route.ts` with exactly:

```ts
import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { read } from "@/lib/admin/guard";
import { perCarRevenue } from "@/lib/admin/reports";
import { arubaToday } from "@/lib/booking/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

/** GET /api/admin/reports/per-car?year=YYYY — per-car monthly revenue matrix
 *  plus the borg (security deposit) summary. Read-only, owner-only. */
export const GET = withRoute(async (req) => {
  const url = new URL(req.url);
  const q = parseParams(Object.fromEntries(url.searchParams), QuerySchema);
  const year = q.year ?? Number(arubaToday().slice(0, 4));
  return json(await read(req, () => perCarRevenue(year)), req);
});
```

- [ ] Typecheck: `npx tsc --noEmit`. Expected: no output.
- [ ] Lint: `npm run lint`. Expected: no errors (warnings that already existed are fine).
- [ ] Run the suite to confirm nothing regressed: `npm test -- --no-file-parallelism`. Expected: all green.
- [ ] Commit: `git add "src/app/api/admin/reports/per-car/route.ts" && git commit -m "feat(reports): per-car revenue admin API route"`

---

### Task 3: `renderRevenueReportPdf` in `src/lib/pdf/report.tsx`

**Files:**
- Create: `src/lib/pdf/report.tsx`
- Test: `src/test/pdf-report.test.ts` (new)

**Interfaces:**
- Consumes: `@react-pdf/renderer` (already a dependency, introduced by plan 06: `Document, Page, Text, View, StyleSheet, renderToBuffer`). No database access; this module is a pure data-to-bytes renderer.
- Produces (seam `PDF (plans 06, 07)`): `renderRevenueReportPdf(data: RevenueReportData): Promise<Uint8Array>` exported from `src/lib/pdf/report.tsx`, plus the helper `reportPdfFilename(year: number, month?: number): string` returning `revenue-YYYY.pdf` / `revenue-YYYY-MM.pdf`. `RevenueReportData` is `{ kind: "monthly" | "yearly", year: number, month?: number, currency: string, generatedOn: string, operatorName: string, rows: { plate: string, name: string, class: string, monthCents: number[], totalCents: number }[], grandTotalCents: number, borg: { heldCents, returnedCents, withheldCents, withheldCount, withheldItems: {plate, name, amountCents, reason}[] } }`. Task 4's route consumes both exports; `rows`/`borg` are structurally compatible with Task 1's `PerCarRevenueReport` so the route can pass them straight through.

Layout: yearly = landscape A4, the 12-month matrix grouped by class with column totals and a coral grand total, then the borg panel. Monthly = portrait A4, one amount column for the chosen month, grouped by class, with a total row. Sand & Surf palette (sand `#F2EBDD`, teal `#0E3A40`, coral `#FF6F59`, ink `#1C2B2E`, ink-soft `#586A6D`, line `#E3DAC8`, fill `#F4EEE1`), built-in Helvetica only (no external assets). All copy dash-free.

**Steps:**

- [ ] Verify the dependency exists: `npm ls @react-pdf/renderer`. Expected: a line like `@react-pdf/renderer@4.x.x`. If it prints `(empty)` or errors, STOP: plan 06 has not been merged; this plan depends on it.
- [ ] Write the failing test. Create `src/test/pdf-report.test.ts` with exactly:

```ts
import { describe, it, expect } from "vitest";
import { renderRevenueReportPdf, reportPdfFilename, type RevenueReportData } from "@/lib/pdf/report";

const base: RevenueReportData = {
  kind: "yearly",
  year: 2026,
  currency: "USD",
  generatedOn: "2026-07-27",
  operatorName: "FleetDesk",
  rows: [
    { plate: "V-101", name: "Toyota Yaris", class: "Economy", monthCents: [0, 0, 40000, 30000, 0, 30000, 0, 0, 0, 0, 0, 0], totalCents: 100000 },
    { plate: "V-202", name: "Suzuki Jimny", class: "4x4", monthCents: [20000, 0, 501, 500, 0, 5000, 0, 0, 0, 0, 0, 0], totalCents: 26001 },
  ],
  grandTotalCents: 126001,
  borg: {
    heldCents: 100000, returnedCents: 30000, withheldCents: 20000, withheldCount: 1,
    withheldItems: [{ plate: "V-101", name: "Toyota Yaris", amountCents: 20000, reason: "Scratched rear bumper" }],
  },
};

const isPdf = (bytes: Uint8Array) => new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";

describe("renderRevenueReportPdf", () => {
  it("renders a yearly report as a real PDF", async () => {
    const bytes = await renderRevenueReportPdf(base);
    expect(isPdf(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("renders a monthly report as a real PDF", async () => {
    const bytes = await renderRevenueReportPdf({ ...base, kind: "monthly", month: 3 });
    expect(isPdf(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("renders an empty fleet without throwing", async () => {
    const bytes = await renderRevenueReportPdf({
      ...base,
      rows: [],
      grandTotalCents: 0,
      borg: { heldCents: 0, returnedCents: 0, withheldCents: 0, withheldCount: 0, withheldItems: [] },
    });
    expect(isPdf(bytes)).toBe(true);
  });
});

describe("reportPdfFilename", () => {
  it("names the yearly report revenue-YYYY.pdf", () => {
    expect(reportPdfFilename(2026)).toBe("revenue-2026.pdf");
  });

  it("names the monthly report revenue-YYYY-MM.pdf with a padded month", () => {
    expect(reportPdfFilename(2026, 3)).toBe("revenue-2026-03.pdf");
    expect(reportPdfFilename(2026, 11)).toBe("revenue-2026-11.pdf");
  });
});
```

- [ ] Run the test to verify it fails: `npm test -- --no-file-parallelism src/test/pdf-report.test.ts`. Expected: collection error `Cannot find module '@/lib/pdf/report'` (or equivalent missing-module failure).
- [ ] Create `src/lib/pdf/report.tsx` with exactly:

```tsx
/**
 * Revenue report PDFs (monthly + yearly), rendered server-side with
 * @react-pdf/renderer (dependency shared with the rental contract PDF).
 * Sand & Surf styled to match the admin: sand paper, deep teal ink, one coral
 * accent on the grand total. Revenue is rental income only; the borg panel is
 * informational and never mixes into the revenue figures. Built-in Helvetica
 * only, so nothing external is ever fetched. Copy is dash-free.
 */
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";

export interface RevenueReportRow {
  plate: string;
  name: string;
  class: string;
  monthCents: number[]; // 12 entries, January first
  totalCents: number;
}

export interface RevenueReportBorg {
  heldCents: number;
  returnedCents: number;
  withheldCents: number;
  withheldCount: number;
  withheldItems: { plate: string; name: string; amountCents: number; reason: string }[];
}

export interface RevenueReportData {
  kind: "monthly" | "yearly";
  year: number;
  /** 1..12; required when kind is "monthly", ignored otherwise. */
  month?: number;
  currency: string;
  /** YYYY-MM-DD, Aruba local. */
  generatedOn: string;
  operatorName: string;
  rows: RevenueReportRow[];
  grandTotalCents: number;
  borg: RevenueReportBorg;
}

export function reportPdfFilename(year: number, month?: number): string {
  return month ? `revenue-${year}-${String(month).padStart(2, "0")}.pdf` : `revenue-${year}.pdf`;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Sand & Surf (mirrors src/app/admin/admin.css custom properties).
const SAND = "#F2EBDD";
const TEAL = "#0E3A40";
const CORAL = "#FF6F59";
const INK = "#1C2B2E";
const INK_SOFT = "#586A6D";
const INK_MUTE = "#8B9B9D";
const LINE = "#E3DAC8";
const FILL = "#F4EEE1";

const S = StyleSheet.create({
  page: { backgroundColor: SAND, color: INK, padding: 36, fontSize: 8, fontFamily: "Helvetica" },
  brand: { fontSize: 13, color: TEAL, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  title: { fontSize: 19, color: INK, fontFamily: "Helvetica-Bold", marginBottom: 3 },
  sub: { fontSize: 8, color: INK_SOFT, marginBottom: 14 },
  panel: { backgroundColor: "#FFFFFF", borderRadius: 8, borderWidth: 1, borderColor: LINE, padding: 12, marginBottom: 12 },
  h2: { fontSize: 11, color: TEAL, fontFamily: "Helvetica-Bold", marginBottom: 8 },
  headRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: LINE, paddingBottom: 4 },
  headCell: { fontSize: 6.5, color: INK_SOFT, textTransform: "uppercase" },
  row: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: FILL, paddingVertical: 3, alignItems: "center" },
  groupRow: { flexDirection: "row", backgroundColor: FILL, paddingVertical: 3, paddingHorizontal: 2, marginTop: 4 },
  groupLabel: { fontSize: 7, color: TEAL, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.6 },
  carCell: { flexBasis: 130, flexGrow: 0, flexShrink: 0, textAlign: "left", paddingRight: 4 },
  monthCell: { flexGrow: 1, flexBasis: 0, textAlign: "right" },
  totalCell: { flexBasis: 58, flexGrow: 0, flexShrink: 0, textAlign: "right" },
  amountCell: { flexGrow: 1, flexBasis: 0, textAlign: "right" },
  bold: { fontFamily: "Helvetica-Bold" },
  zero: { color: INK_MUTE },
  totalRow: { flexDirection: "row", borderTopWidth: 2, borderTopColor: TEAL, paddingTop: 5, marginTop: 2 },
  coral: { color: CORAL },
  borgTiles: { flexDirection: "row", marginBottom: 8 },
  borgTile: { flexGrow: 1, flexBasis: 0, backgroundColor: FILL, borderRadius: 6, padding: 8, marginRight: 8 },
  borgTileLast: { flexGrow: 1, flexBasis: 0, backgroundColor: FILL, borderRadius: 6, padding: 8 },
  borgLabel: { fontSize: 6.5, color: INK_SOFT, textTransform: "uppercase", marginBottom: 3 },
  borgValue: { fontSize: 12, fontFamily: "Helvetica-Bold", color: INK },
  note: { fontSize: 7, color: INK_SOFT, marginTop: 6 },
});

const sym = (currency: string) => ({ AWG: "Afl.", USD: "$" } as Record<string, string>)[currency] ?? currency;
const units = (cents: number) => Math.round(cents / 100).toLocaleString("en-US");
const money = (cents: number, currency: string) => `${sym(currency)} ${units(cents)}`;

function groupRows(rows: RevenueReportRow[]): { class: string; rows: RevenueReportRow[] }[] {
  const out: { class: string; rows: RevenueReportRow[] }[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.class === r.class) last.rows.push(r);
    else out.push({ class: r.class, rows: [r] });
  }
  return out;
}

function Header({ d, title }: { d: RevenueReportData; title: string }) {
  return (
    <View>
      <Text style={S.brand}>{d.operatorName}</Text>
      <Text style={S.title}>{title}</Text>
      <Text style={S.sub}>
        Rental income per car. Security deposits are never counted as revenue. Generated on {d.generatedOn}.
      </Text>
    </View>
  );
}

function BorgPanel({ d }: { d: RevenueReportData }) {
  const b = d.borg;
  return (
    <View style={S.panel} wrap={false}>
      <Text style={S.h2}>Borg (security deposits) {d.year}</Text>
      <View style={S.borgTiles}>
        <View style={S.borgTile}>
          <Text style={S.borgLabel}>Held at pickup</Text>
          <Text style={S.borgValue}>{money(b.heldCents, d.currency)}</Text>
        </View>
        <View style={S.borgTile}>
          <Text style={S.borgLabel}>Returned</Text>
          <Text style={S.borgValue}>{money(b.returnedCents, d.currency)}</Text>
        </View>
        <View style={S.borgTileLast}>
          <Text style={S.borgLabel}>Withheld ({b.withheldCount})</Text>
          <Text style={S.borgValue}>{money(b.withheldCents, d.currency)}</Text>
        </View>
      </View>
      {b.withheldItems.map((w, i) => (
        <Text key={i} style={S.note}>
          {w.plate} {w.name}: {money(w.amountCents, d.currency)} withheld. {w.reason}
        </Text>
      ))}
      <Text style={S.note}>
        Borg is money you hold for the customer, not income. It stays out of every revenue figure above.
      </Text>
    </View>
  );
}

function YearlyPage({ d }: { d: RevenueReportData }) {
  const groups = groupRows(d.rows);
  const colTotals = MONTHS_SHORT.map((_, i) => d.rows.reduce((s, r) => s + (r.monthCents[i] ?? 0), 0));
  return (
    <Page size="A4" orientation="landscape" style={S.page}>
      <Header d={d} title={`Revenue ${d.year}`} />
      <View style={S.panel}>
        <View style={S.headRow}>
          <Text style={[S.headCell, S.carCell]}>Car</Text>
          {MONTHS_SHORT.map((m) => (
            <Text key={m} style={[S.headCell, S.monthCell]}>{m}</Text>
          ))}
          <Text style={[S.headCell, S.totalCell]}>Total</Text>
        </View>
        {groups.map((g) => (
          <View key={g.class}>
            <View style={S.groupRow}><Text style={S.groupLabel}>{g.class}</Text></View>
            {g.rows.map((r) => (
              <View key={r.plate} style={S.row} wrap={false}>
                <Text style={S.carCell}>
                  <Text style={S.bold}>{r.plate}</Text>  {r.name}
                </Text>
                {r.monthCents.map((c, i) => (
                  <Text key={i} style={c === 0 ? [S.monthCell, S.zero] : S.monthCell}>{units(c)}</Text>
                ))}
                <Text style={[S.totalCell, S.bold]}>{units(r.totalCents)}</Text>
              </View>
            ))}
          </View>
        ))}
        <View style={S.totalRow}>
          <Text style={[S.carCell, S.bold]}>Total ({d.currency})</Text>
          {colTotals.map((c, i) => (
            <Text key={i} style={[S.monthCell, S.bold]}>{units(c)}</Text>
          ))}
          <Text style={[S.totalCell, S.bold, S.coral]}>{units(d.grandTotalCents)}</Text>
        </View>
        <Text style={S.note}>All amounts in {d.currency}, whole units.</Text>
      </View>
      <BorgPanel d={d} />
    </Page>
  );
}

function MonthlyPage({ d }: { d: RevenueReportData }) {
  const mi = (d.month ?? 1) - 1;
  const groups = groupRows(d.rows);
  const monthTotal = d.rows.reduce((s, r) => s + (r.monthCents[mi] ?? 0), 0);
  return (
    <Page size="A4" style={S.page}>
      <Header d={d} title={`Revenue ${MONTHS_LONG[mi]} ${d.year}`} />
      <View style={S.panel}>
        <View style={S.headRow}>
          <Text style={[S.headCell, S.carCell]}>Car</Text>
          <Text style={[S.headCell, S.amountCell]}>Revenue</Text>
        </View>
        {groups.map((g) => (
          <View key={g.class}>
            <View style={S.groupRow}><Text style={S.groupLabel}>{g.class}</Text></View>
            {g.rows.map((r) => {
              const c = r.monthCents[mi] ?? 0;
              return (
                <View key={r.plate} style={S.row} wrap={false}>
                  <Text style={S.carCell}>
                    <Text style={S.bold}>{r.plate}</Text>  {r.name}
                  </Text>
                  <Text style={c === 0 ? [S.amountCell, S.zero] : S.amountCell}>{money(c, d.currency)}</Text>
                </View>
              );
            })}
          </View>
        ))}
        <View style={S.totalRow}>
          <Text style={[S.carCell, S.bold]}>Total</Text>
          <Text style={[S.amountCell, S.bold, S.coral]}>{money(monthTotal, d.currency)}</Text>
        </View>
        <Text style={S.note}>All amounts in {d.currency}, whole units.</Text>
      </View>
    </Page>
  );
}

export async function renderRevenueReportPdf(data: RevenueReportData): Promise<Uint8Array> {
  const title = data.kind === "yearly"
    ? `Revenue ${data.year}`
    : `Revenue ${MONTHS_LONG[(data.month ?? 1) - 1]} ${data.year}`;
  const doc = (
    <Document title={title} author={data.operatorName}>
      {data.kind === "yearly" ? <YearlyPage d={data} /> : <MonthlyPage d={data} />}
    </Document>
  );
  const buf = await renderToBuffer(doc);
  return new Uint8Array(buf);
}
```

Note on JSX: Next and vitest both compile with the automatic JSX runtime, matching `src/lib/pdf/contract.tsx` from plan 06; do not add a manual `import React` line unless the typecheck demands the same pattern contract.tsx uses.
- [ ] Run the test to verify it passes: `npm test -- --no-file-parallelism src/test/pdf-report.test.ts`. Expected: `Test Files  1 passed`, `Tests  5 passed`.
- [ ] Typecheck: `npx tsc --noEmit`. Expected: no output.
- [ ] Commit: `git add src/lib/pdf/report.tsx src/test/pdf-report.test.ts && git commit -m "feat(reports): Sand & Surf revenue report PDF renderer, monthly and yearly"`

---
### Task 4: `GET /api/admin/reports/pdf` download route

**Files:**
- Create: `src/app/api/admin/reports/pdf/route.ts`

**Interfaces:**
- Consumes: `perCarRevenue` from `@/lib/admin/reports` (Task 1); `renderRevenueReportPdf`, `reportPdfFilename` from `@/lib/pdf/report` (Task 3); `getSettings` from `@/lib/admin/settings` (for `settings.currency`); `arubaToday()` from `@/lib/booking/public`; `siteName` from `@/lib/site-config` (plan 02 seam; see the site-config note in "Codebase state assumed"); `withRoute`, `parseParams`, `read` as in Task 2.
- Produces (seam): `GET /api/admin/reports/pdf?year=YYYY[&month=M]` returning `application/pdf` as an attachment named `revenue-YYYY.pdf` (no `month`) or `revenue-YYYY-MM.pdf` (with `month`, zero padded). Task 5's download buttons point here. Auth is the session cookie via `read` (GET is a safe method, so a plain `<a href>` download works without CSRF headers).

Thin wrapper like Task 2: the aggregation (Task 1) and rendering (Task 3) are unit-tested; this route only wires them and sets headers.

**Steps:**

- [ ] Create `src/app/api/admin/reports/pdf/route.ts` with exactly:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { parseParams } from "@/lib/http/validate";
import { read } from "@/lib/admin/guard";
import { perCarRevenue } from "@/lib/admin/reports";
import { getSettings } from "@/lib/admin/settings";
import { arubaToday } from "@/lib/booking/public";
import { renderRevenueReportPdf, reportPdfFilename } from "@/lib/pdf/report";
import { siteName } from "@/lib/site-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

/** GET /api/admin/reports/pdf?year=YYYY[&month=M] — on-demand revenue report
 *  PDF: the yearly per-car matrix with the borg panel, or a single month.
 *  Rendered per request, streamed back, never stored. Owner-only. */
export const GET = withRoute(async (req) => {
  const url = new URL(req.url);
  const q = parseParams(Object.fromEntries(url.searchParams), QuerySchema);

  const bytes = await read(req, async () => {
    const report = await perCarRevenue(q.year);
    const settings = await getSettings();
    return renderRevenueReportPdf({
      kind: q.month ? "monthly" : "yearly",
      year: q.year,
      month: q.month,
      currency: settings.currency,
      generatedOn: arubaToday(),
      operatorName: siteName,
      rows: report.rows,
      grandTotalCents: report.grandTotalCents,
      borg: report.borg,
    });
  });

  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${reportPdfFilename(q.year, q.month)}"`,
      "Cache-Control": "no-store",
    },
  });
});
```

If `@/lib/site-config` exports a single object (for example `siteConfig`) instead of a named `siteName`, import that object and pass its `siteName` property as `operatorName`; do not hardcode a brand string, because the Tex port swaps the brand via this config.
- [ ] Typecheck: `npx tsc --noEmit`. Expected: no output.
- [ ] Lint: `npm run lint`. Expected: no errors.
- [ ] Run the suite: `npm test -- --no-file-parallelism`. Expected: all green.
- [ ] Commit: `git add "src/app/api/admin/reports/pdf/route.ts" && git commit -m "feat(reports): revenue report PDF download route"`

---

### Task 5: Reports page: per-car matrix, borg panel, year selector, Download PDF buttons

**Files:**
- Modify: `src/app/admin/(shell)/reports/page.tsx` (full-file replacement below; the pre-wave file is 211 lines and every existing section is preserved inside the new file)
- Modify: `src/app/admin/(shell)/reports/reports.css` (append after the closing brace of the `@media (prefers-reduced-motion: reduce)` block, pre-wave line 58)

**Interfaces:**
- Consumes: `GET /api/admin/reports` (existing `Reports` JSON) and `GET /api/admin/reports/per-car?year=YYYY` (Task 2's `PerCarRevenueReport` JSON); `GET /api/admin/reports/pdf?year=&month=` via anchor-tag downloads (Task 4); `Skeleton, EmptyState, useToast, registerPaletteAction` from `@/app/admin/_ui`; `Select` from `@/components/ui`; `apiGet, ApiError` from `../../client`; global admin classes `.panel`, `.sub`, `.btn`, `.btn--accent`, `.rp-kpi`, `.muted` from `admin.css`.
- Produces: the finished `/admin/reports` page. UI-only task (no TDD; typecheck + lint + manual verification instead). No other task consumes this file.

This is a client component page, matching the existing pattern. Currency comes from the existing `/api/admin/reports` payload; the per-car endpoint stays exactly the seam shape. Downloads are plain `<a>` tags (one click, session-cookie auth, no JS needed). Copy is dash-free.

**Steps:**

- [ ] Replace the entire contents of `src/app/admin/(shell)/reports/page.tsx` with exactly:

```tsx
"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { apiGet, type ApiError } from "../../client";
import {
  Skeleton,
  EmptyState,
  useToast,
  registerPaletteAction,
} from "@/app/admin/_ui";
import { Select } from "@/components/ui";
import "./reports.css";

interface Reports {
  currency: string;
  month: string;
  kpis: {
    revenueAllCents: number; revenueMonthCents: number; rentalsThisMonth: number;
    activeRentals: number; utilizationPct: number; idleCars: number;
  };
  revenueByMonth: { month: string; cents: number }[];
  revenueByClass: { class: string; cents: number }[];
  topVehicles: { plate: string; name: string; cents: number; rentals: number }[];
}

interface PerCarRow {
  vehicleId: string; name: string; plate: string; class: string;
  monthCents: number[]; totalCents: number;
}

interface PerCarRevenue {
  year: number;
  months: string[];
  rows: PerCarRow[];
  grandTotalCents: number;
  borg: {
    heldCents: number; returnedCents: number; withheldCents: number; withheldCount: number;
    withheldItems: { plate: string; name: string; amountCents: number; reason: string }[];
  };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const SUB_COPY = "Revenue is the rental subtotal on every confirmed, picked up and completed booking. Cancelled rentals never count, and security deposits are never revenue.";

export default function ReportsPage() {
  const [data, setData] = useState<Reports | null>(null);
  const [err, setErr] = useState("");
  const [perCar, setPerCar] = useState<PerCarRevenue | null>(null);
  const [perCarErr, setPerCarErr] = useState("");
  const nowYear = new Date().getFullYear();
  const [year, setYear] = useState(String(nowYear));
  const [month, setMonth] = useState(String(new Date().getMonth() + 1));

  const toast = useToast();

  const load = useCallback(() => {
    apiGet<Reports>("/api/admin/reports")
      .then(setData)
      .catch((e) => {
        const message = (e as ApiError).message;
        setErr(message);
        toast.show({ type: "error", message });
      });
  }, [toast]);

  const loadPerCar = useCallback((y: string) => {
    setPerCarErr("");
    setPerCar(null);
    apiGet<PerCarRevenue>(`/api/admin/reports/per-car?year=${y}`)
      .then(setPerCar)
      .catch((e) => {
        const message = (e as ApiError).message;
        setPerCarErr(message);
        toast.show({ type: "error", message });
      });
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadPerCar(year); }, [loadPerCar, year]);

  // Page-scoped command-palette actions: refresh, and a one-keystroke PDF grab.
  useEffect(
    () =>
      registerPaletteAction({
        id: "reports-refresh",
        label: "Refresh reports",
        hint: "Reports",
        keywords: "reports revenue refresh reload numbers kpi",
        run: () => { setErr(""); setData(null); load(); loadPerCar(year); },
      }),
    [load, loadPerCar, year],
  );

  useEffect(
    () =>
      registerPaletteAction({
        id: "reports-year-pdf",
        label: `Download revenue PDF ${year}`,
        hint: "Reports",
        keywords: "reports revenue pdf download export year",
        run: () => { window.location.assign(`/api/admin/reports/pdf?year=${year}`); },
      }),
    [year],
  );

  if (err) {
    return (
      <>
        <h1>Reports</h1>
        <p className="sub">{SUB_COPY}</p>
        <div className="panel">
          <EmptyState
            title="Could not load reports"
            hint={err}
            action={
              <button type="button" className="btn btn--accent" onClick={() => { setErr(""); setData(null); load(); loadPerCar(year); }}>
                Try again
              </button>
            }
          />
        </div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <h1>Reports</h1>
        <p className="sub">{SUB_COPY}</p>

        <div className="rp-kpis" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <div className={`rp-kpi${i === 0 ? " rp-kpi--accent" : ""}`} key={i}>
              <span><Skeleton width="70%" height={9} /></span>
              <b><Skeleton width="55%" height={26} radius={8} /></b>
            </div>
          ))}
        </div>

        <div className="panel rp-percar" aria-busy="true">
          <h2>Revenue per car</h2>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} style={{ padding: ".45rem 0" }}><Skeleton width="100%" height={14} /></div>
          ))}
        </div>

        <div className="rp-grid">
          <div className="panel">
            <h2>Revenue by month</h2>
            <div className="rp-bars" aria-busy="true">
              {Array.from({ length: 8 }).map((_, i) => (
                <div className="rp-bar rp-bar--skel" key={i}>
                  <div className="rp-bar__track">
                    <Skeleton width="100%" height={`${30 + ((i * 37) % 60)}%`} radius="7px 7px 0 0" style={{ display: "block" }} />
                  </div>
                  <div className="rp-bar__label"><Skeleton width="60%" height={9} /></div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <h2>Revenue by class</h2>
            <div className="rp-hbars" aria-busy="true">
              {Array.from({ length: 5 }).map((_, i) => (
                <div className="rp-hbar" key={i}>
                  <span className="rp-hbar__label"><Skeleton width="80%" height={11} /></span>
                  <span className="rp-hbar__track"><Skeleton width={`${80 - i * 14}%`} height={13} radius={7} style={{ display: "block" }} /></span>
                  <span className="rp-hbar__val"><Skeleton width={48} height={11} /></span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="panel">
          <h2>Top earning cars</h2>
          <div className="rp-hbars" aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <div className="rp-hbar" key={i}>
                <span className="rp-hbar__label"><Skeleton width="75%" height={11} /></span>
                <span className="rp-hbar__track"><Skeleton width={`${85 - i * 13}%`} height={13} radius={7} style={{ display: "block" }} /></span>
                <span className="rp-hbar__val"><Skeleton width={56} height={11} /></span>
              </div>
            ))}
          </div>
        </div>
      </>
    );
  }

  const sym = ({ AWG: "Afl.", USD: "$" } as Record<string, string>)[data.currency] ?? data.currency;
  const fmt = (cents: number) => `${sym} ${Math.round(cents / 100).toLocaleString("en-US")}`;
  const monthLabel = (mk: string) => new Date(`${mk}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const maxMonth = Math.max(1, ...data.revenueByMonth.map((m) => m.cents));
  const maxClass = Math.max(1, ...data.revenueByClass.map((c) => c.cents));
  const maxVeh = Math.max(1, ...data.topVehicles.map((v) => v.cents));

  const yearOptions = Array.from({ length: 6 }, (_, i) => {
    const y = String(nowYear - i);
    return { value: y, label: y };
  });
  const monthOptions = MONTH_NAMES.map((m, i) => ({ value: String(i + 1), label: m }));

  return (
    <>
      <h1>Reports</h1>
      <p className="sub">{SUB_COPY}</p>

      <div className="rp-kpis">
        <div className="rp-kpi rp-kpi--accent"><span>Revenue this month</span><b>{fmt(data.kpis.revenueMonthCents)}</b></div>
        <div className="rp-kpi"><span>Revenue all time</span><b>{fmt(data.kpis.revenueAllCents)}</b></div>
        <div className="rp-kpi"><span>Out on rental now</span><b>{data.kpis.activeRentals}</b></div>
        <div className="rp-kpi"><span>Fleet booked, next 30 days</span><b>{data.kpis.utilizationPct}%</b></div>
        <div className="rp-kpi"><span>Rentals starting this month</span><b>{data.kpis.rentalsThisMonth}</b></div>
        <div className="rp-kpi"><span>Idle cars, next 30 days</span><b>{data.kpis.idleCars}</b></div>
      </div>

      <div className="panel rp-percar">
        <div className="rp-percar__head">
          <h2>Revenue per car <span className="v">{year}</span></h2>
          <div className="rp-percar__tools">
            <Select ariaLabel="Report year" value={year} onChange={setYear} options={yearOptions} />
            <Select ariaLabel="Month for the monthly PDF" value={month} onChange={setMonth} options={monthOptions} />
            <a className="btn" href={`/api/admin/reports/pdf?year=${year}&month=${month}`}>Month PDF</a>
            <a className="btn btn--accent" href={`/api/admin/reports/pdf?year=${year}`}>Year PDF</a>
          </div>
        </div>
        {perCarErr ? (
          <EmptyState
            title="Could not load the per car numbers"
            hint={perCarErr}
            action={
              <button type="button" className="btn" onClick={() => loadPerCar(year)}>Try again</button>
            }
          />
        ) : !perCar ? (
          <div aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} style={{ padding: ".45rem 0" }}><Skeleton width="100%" height={14} /></div>
            ))}
          </div>
        ) : perCar.rows.length === 0 ? (
          <EmptyState title="No cars yet" hint="Add vehicles to the fleet and their monthly earnings will build up here." />
        ) : (
          <div className="rp-matrix-wrap">
            <table className="rp-matrix">
              <thead>
                <tr>
                  <th className="rp-matrix__car" scope="col">Car</th>
                  {perCar.months.map((mk) => <th key={mk} scope="col">{monthLabel(mk)}</th>)}
                  <th scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {perCar.rows.map((r, idx) => {
                  const prev = perCar.rows[idx - 1];
                  const showGroup = !prev || prev.class !== r.class;
                  return (
                    <Fragment key={r.vehicleId}>
                      {showGroup && (
                        <tr className="rp-matrix__group"><th colSpan={14} scope="colgroup">{r.class}</th></tr>
                      )}
                      <tr>
                        <th scope="row" className="rp-matrix__car"><b>{r.plate}</b> <small className="muted">{r.name}</small></th>
                        {r.monthCents.map((c, i) => (
                          <td key={i} className={c === 0 ? "rp-matrix__zero" : undefined}>{fmt(c)}</td>
                        ))}
                        <td className="rp-matrix__total">{fmt(r.totalCents)}</td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" className="rp-matrix__car">Total</th>
                  {perCar.months.map((mk, i) => (
                    <td key={mk}>{fmt(perCar.rows.reduce((s, r) => s + (r.monthCents[i] ?? 0), 0))}</td>
                  ))}
                  <td className="rp-matrix__total">{fmt(perCar.grandTotalCents)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Borg <span className="v">security deposits, {year}</span></h2>
        {!perCar ? (
          <div aria-busy="true"><Skeleton width="100%" height={48} /></div>
        ) : (
          <>
            <div className="rp-borg">
              <div className="rp-kpi"><span>Held at pickup</span><b>{fmt(perCar.borg.heldCents)}</b></div>
              <div className="rp-kpi"><span>Returned</span><b>{fmt(perCar.borg.returnedCents)}</b></div>
              <div className="rp-kpi"><span>Withheld ({perCar.borg.withheldCount})</span><b>{fmt(perCar.borg.withheldCents)}</b></div>
            </div>
            {perCar.borg.withheldItems.length > 0 && (
              <ul className="rp-borg-items">
                {perCar.borg.withheldItems.map((w, i) => (
                  <li key={i}><b>{w.plate}</b> <small className="muted">{w.name}</small> {fmt(w.amountCents)} withheld. {w.reason}</li>
                ))}
              </ul>
            )}
            <p className="sub" style={{ margin: ".6rem 0 0" }}>Borg is money you hold for the customer, not income. It never counts toward revenue.</p>
          </>
        )}
      </div>

      <div className="rp-grid">
        <div className="panel">
          <h2>Revenue by month</h2>
          {data.revenueByMonth.every((m) => m.cents === 0) ? (
            <EmptyState title="No revenue yet" hint="Confirmed and completed rentals will chart here month by month." />
          ) : (
            <div className="rp-bars">
              {data.revenueByMonth.map((m) => (
                <div className="rp-bar" key={m.month}>
                  <div className="rp-bar__val">{m.cents > 0 ? fmt(m.cents) : ""}</div>
                  <div className="rp-bar__track"><div className="rp-bar__fill" style={{ height: `${(m.cents / maxMonth) * 100}%` }} /></div>
                  <div className="rp-bar__label">{monthLabel(m.month)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Revenue by class</h2>
          {data.revenueByClass.length === 0 ? (
            <EmptyState title="No revenue yet" hint="Once cars start renting, earnings split by class will show here." />
          ) : (
            <div className="rp-hbars">
              {data.revenueByClass.map((c) => (
                <div className="rp-hbar" key={c.class}>
                  <span className="rp-hbar__label">{c.class}</span>
                  <span className="rp-hbar__track"><span className="rp-hbar__fill" style={{ width: `${(c.cents / maxClass) * 100}%` }} /></span>
                  <span className="rp-hbar__val">{fmt(c.cents)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>Top earning cars</h2>
        {data.topVehicles.length === 0 ? (
          <EmptyState title="No revenue yet" hint="Your best earning cars will be ranked here as bookings come in." />
        ) : (
          <div className="rp-hbars">
            {data.topVehicles.map((v) => (
              <div className="rp-hbar" key={v.plate}>
                <span className="rp-hbar__label"><b>{v.plate}</b> <small className="muted">{v.name}</small></span>
                <span className="rp-hbar__track"><span className="rp-hbar__fill" style={{ width: `${(v.cents / maxVeh) * 100}%` }} /></span>
                <span className="rp-hbar__val">{fmt(v.cents)} <small className="muted">· {v.rentals}</small></span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
```

- [ ] Append the matrix and borg styles to `src/app/admin/(shell)/reports/reports.css` (after the reduced-motion block that ends the pre-wave file at line 58):

```css
/* --- Per-car revenue matrix (wave 07) ------------------------------------ */
/* The 12-month table needs the full content width; wide content scrolls
   inside its own wrapper so the page never scrolls sideways. */
.rp-percar { max-width: none; }
.rp-percar__head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
.rp-percar__head h2 { margin: 0; }
.rp-percar__tools { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.rp-matrix-wrap { overflow-x: auto; }
.rp-matrix { border-collapse: collapse; width: 100%; font-size: .82rem; font-variant-numeric: tabular-nums; }
.rp-matrix th, .rp-matrix td { padding: .45rem .55rem; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--line-soft); }
.rp-matrix thead th { font-family: var(--font-mono); font-size: .68rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-soft); }
.rp-matrix .rp-matrix__car { text-align: left; position: sticky; left: 0; background: var(--panel); }
.rp-matrix__group th { text-align: left; font-family: var(--font-mono); font-size: .68rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--teal); background: var(--fill); }
.rp-matrix__zero { color: var(--ink-mute); }
.rp-matrix__total { font-weight: 700; }
.rp-matrix tfoot th, .rp-matrix tfoot td { border-top: 2px solid var(--line); border-bottom: 0; font-weight: 700; }

/* Borg panel: reuse the KPI tile look; deposits stay visually separate from
   the revenue charts above. */
.rp-borg { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .8rem; margin-bottom: .4rem; }
.rp-borg-items { margin: .6rem 0 0; padding: 0; list-style: none; }
.rp-borg-items li { padding: .5rem 0; border-top: 1px solid var(--line-soft); font-size: .88rem; }
```

- [ ] Typecheck: `npx tsc --noEmit`. Expected: no output.
- [ ] Lint: `npm run lint`. Expected: no errors.
- [ ] Run the suite (guards against accidental shared-module edits): `npm test -- --no-file-parallelism`. Expected: all green.
- [ ] Manual verification (make sure NO `npm run build` runs while the dev server is up):
  1. Start the dev server: `npm run dev`.
  2. Sign in at `http://localhost:3000/admin/login` (if no local admin exists, create one first with `npm run demo:admin` in a second terminal, then use the credentials it prints).
  3. Open `http://localhost:3000/admin/reports`. Verify: the "Revenue per car" panel shows a table grouped by class with sticky car column, 12 month columns, a Total column, a grand-total footer row, and a year Select; the "Borg" panel shows Held at pickup / Returned / Withheld tiles (zeros are fine on a fresh database); zero cells render muted.
  4. Click "Year PDF". Verify the browser downloads `revenue-<year>.pdf` and it opens as a landscape Sand & Surf matrix with the borg panel at the bottom.
  5. Pick a month in the month Select, click "Month PDF". Verify the download is `revenue-<year>-<MM>.pdf` (zero-padded) and opens as a portrait one-month breakdown.
  6. Change the year in the Select. Verify the matrix reloads for that year and both PDF links now carry the new year.
  7. Open the command palette (Cmd+K) and type "pdf". Verify the "Download revenue PDF <year>" action appears and triggers the yearly download.
  8. Stop the dev server.
- [ ] Commit: `git add "src/app/admin/(shell)/reports/page.tsx" "src/app/admin/(shell)/reports/reports.css" && git commit -m "feat(reports): per-car matrix, borg panel and PDF downloads on the reports page"`

---

## Done when

- `npm test -- --no-file-parallelism` is fully green including `src/test/admin-reports-percar.test.ts` (10 tests) and `src/test/pdf-report.test.ts` (5 tests).
- `/admin/reports` shows the per-car matrix with year selector, the borg panel with withheld reasons, and working Month PDF / Year PDF downloads named `revenue-YYYY-MM.pdf` / `revenue-YYYY.pdf`.
- Revenue figures everywhere on the page count `confirmed`, `picked_up` and `completed` snapshots only; no payment row and no borg amount ever feeds a revenue number.
