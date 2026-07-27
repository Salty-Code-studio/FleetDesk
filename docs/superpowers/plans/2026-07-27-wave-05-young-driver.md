# Under-21 Young-Driver Surcharge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow 18 to 20 year old drivers to book with a per-day surcharge that is priced honestly from the first quote, verified against the licence DOB at booking creation, and snapshotted into `priceBreakdown` so it flows into deposit, Stripe, emails, and the contract automatically.

**Architecture:** Three settings (`minDriverAge` default drops to 18, new `youngDriverAge`, new `youngDriverFeeCentsPerDay`) drive a `youngDriverCents` line inside the existing server-only `quote()` breakdown; because the line folds into `subtotalCents`, every downstream consumer (plan 02's `paymentAmounts`, Stripe checkout, emails, plan 06 contract, plan 07 reports) inherits it with zero changes. The public wizard gains an age selector on step 2 whose claimed band rides the quote request; `createBooking` re-derives the band from the encrypted-at-rest licence DOB (the truth), reprices on mismatch, and returns `priceAdjusted: true` so the wizard shows a transparent notice before any money moves. Under `minDriverAge` still hard-rejects.

**Tech Stack:** Next.js 15 App Router (route handlers with `withRoute`), zod at every boundary, Drizzle ORM (PGlite dev/test, Supabase Postgres prod), vitest.

## Global Constraints

- Tests: `npm test -- --no-file-parallelism` (vitest). New features land with tests.
- NEVER `npm run build` while a `next dev` server is running (shared `.next` corrupts).
- Migrations: `npm run db:generate` for drizzle diffs; hand-written SQL files in `./drizzle` for constraints/enum surgery (precedent: 0002, 0007, 0010). Applied with `npm run db:migrate`. Must work on BOTH PGlite (`pglite://`, dev/test) and Postgres (Supabase prod).
- Admin mutations go through `mutate(req, action, fn)` from `src/lib/admin/guard.ts` (audit-logged); reads through `read(req, fn)`.
- Admin UI: reuse `Modal, Drawer, useToast, useConfirm, Skeleton, EmptyState, registerPaletteAction` from `@/app/admin/_ui` and `DatePicker, Select` from `@/components/ui`. Strict CSP: no external assets ever. Money is integer cents.
- Copy: dash-free house style (no em-dashes), warm/human tone.
- Timezone: operator-local day logic uses `America/Aruba` (existing `arubaToday()` precedent).
- Design principle: less clicking. One click from a planning bar opens the BookingDrawer with everything in it.

Workstream-5 specific (from the spec, authoritative):

- DOB is collected only at the licence step, AES-256-GCM encrypted at rest, and NEVER re-readable. Any age-derived pricing must be snapshotted into `priceBreakdown` at creation time.
- The claimed age band from the wizard is a pricing hint only; the licence DOB decides. Mismatch means transparent reprice BEFORE payment, never a post-payment surprise. Price can go down too (claimed young, actually older).
- Under `minDriverAge` remains a hard 400 reject (existing `validateLicense` behavior, threshold now defaulting to 18).
- Existing settings rows are untouched by the default change (only the column DEFAULT changes; a live operator keeps their configured 21 until they edit it).

## Sequencing context (read this first)

This plan is number 05 in the wave. Plans 01 (time-aware booking) and 02 (payment redesign + extensions) are ALREADY MERGED when you implement this. That means, per the seams doc `docs/superpowers/plans/SEAMS-2026-07-wave.md`:

- `bookings` columns are `start_at`/`end_at`/`buffer_end_at` timestamptz; public APIs accept ISO datetime OR date-only values (date-only defaults to `settings.openingTime`).
- `QuoteBreakdown` in `src/lib/booking/quote.ts` ALREADY has a `youngDriverCents: number` field, hardcoded to 0 by plan 02. This plan wires it.
- `paymentAmounts(breakdown, option, settings)` in `src/lib/payments/charge.ts` derives deposit and pay-now from `breakdown.subtotalCents`, so folding the fee into subtotal is all the payment wiring this plan needs.
- `extendBooking(bookingId, { endAt, payment, actor })` in `src/lib/admin/extend-booking.ts` re-quotes the full new duration; this plan makes that re-quote preserve the young-driver flag.
- `BookingDrawer` exists; nothing in this plan touches it.

Because plans 01/02 rewrote parts of the files this plan touches, the pre-wave line numbers quoted below are approximate anchors. Every task tells you the stable landmark (a function name, a call expression, a JSX block) to anchor on. Where a plan-01 rename is possible (`startDate` vs `startAt` field names on input schemas), the task gives both spellings and tells you to check the file first; this is a two-second check, do it before writing test code.

---

### Task 1: Young-driver settings (schema, migration, patch schema)

**Files:**
- Modify: `src/lib/db/schema/settings.ts` (the `settings` pgTable; `minDriverAge` is at pre-wave line 13)
- Create: one generated migration in `./drizzle` via `npm run db:generate`
- Modify: `src/lib/admin/settings.ts` (`SettingsPatchSchema`, pre-wave lines 13-26)
- Test: `src/test/admin-settings.test.ts` (extend)

**Interfaces:**
- Consumes: existing `settings` singleton table, `getSettings()` / `patchSettings()` / `SettingsPatchSchema` from `src/lib/admin/settings.ts`, `centsField` from `src/lib/admin/money.ts` (a zod int-cents validator already imported in that file).
- Produces (seam names, canonical): settings columns `youngDriverAge` -> `young_driver_age` int NOT NULL default 21, `youngDriverFeeCentsPerDay` -> `young_driver_fee_cents_per_day` int NOT NULL default 1000, `minDriverAge` default changed 21 -> 18 (existing rows untouched). Every later task reads these via `getSettings()`.

**Steps:**

- [ ] Write the failing test. In `src/test/admin-settings.test.ts`, add this `it` block IMMEDIATELY AFTER the existing `it("self-heals and returns the singleton", ...)` block (order matters: a later test patches `minDriverAge`, so the defaults assertion must run before it):

```ts
  it("defaults the young-driver settings and the new minimum age", async () => {
    const s = await getSettings();
    expect(s.minDriverAge).toBe(18);
    expect(s.youngDriverAge).toBe(21);
    expect(s.youngDriverFeeCentsPerDay).toBe(1000);
  });
```

  And add these two blocks after the existing `it("validates ranges and the min≤max invariant", ...)` block:

```ts
  it("patches the young-driver settings", async () => {
    const updated = await patchSettings({ youngDriverAge: 23, youngDriverFeeCentsPerDay: 1500 });
    expect(updated.youngDriverAge).toBe(23);
    expect(updated.youngDriverFeeCentsPerDay).toBe(1500);
    // restore so later files that share the test database see the defaults
    await patchSettings({ youngDriverAge: 21, youngDriverFeeCentsPerDay: 1000 });
  });

  it("range-checks the young-driver settings", () => {
    expect(SettingsPatchSchema.safeParse({ youngDriverAge: 12 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ youngDriverAge: 120 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ youngDriverFeeCentsPerDay: -1 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ youngDriverAge: 21, youngDriverFeeCentsPerDay: 1000 }).success).toBe(true);
  });
```

- [ ] Run the test to verify it fails: `npm test -- --no-file-parallelism src/test/admin-settings.test.ts`. Expected: the new tests fail with TypeScript/property errors (`youngDriverAge` does not exist on the settings row) or zod `.strict()` rejections; the pre-existing tests still pass.
- [ ] Modify `src/lib/db/schema/settings.ts`. Inside the `settings` pgTable, change the `minDriverAge` line and add two columns directly under it:

```ts
  minDriverAge: integer("min_driver_age").notNull().default(18),
  // Drivers at least minDriverAge but under youngDriverAge pay the per-day
  // young-driver fee (workstream 5). Set the fee to 0 to disable the surcharge.
  youngDriverAge: integer("young_driver_age").notNull().default(21),
  youngDriverFeeCentsPerDay: integer("young_driver_fee_cents_per_day").notNull().default(1000),
```

- [ ] Generate the migration: run `npm run db:generate`. Inspect the newly created SQL file in `./drizzle` (highest number; do NOT assume a specific number, other plans added migrations before this one). It must contain exactly these three effects; if drizzle-kit omitted the default change for `min_driver_age`, append that statement to the generated file by hand:

```sql
ALTER TABLE "settings" ALTER COLUMN "min_driver_age" SET DEFAULT 18;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "young_driver_age" integer DEFAULT 21 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "young_driver_fee_cents_per_day" integer DEFAULT 1000 NOT NULL;
```

- [ ] Modify `src/lib/admin/settings.ts`. In `SettingsPatchSchema`, add two fields directly after the `minDriverAge` line (keep `.strict()` and the existing refine untouched):

```ts
  youngDriverAge: z.number().int().min(16).max(99).optional(),
  youngDriverFeeCentsPerDay: centsField.optional(),
```

- [ ] Run the test to verify it passes: `npm test -- --no-file-parallelism src/test/admin-settings.test.ts`. Expected: all tests in the file pass.
- [ ] Run the full suite to catch fallout: `npm test -- --no-file-parallelism`. Expected: green. (The default change 21 -> 18 is safe: no existing test asserts a 21 default, and the under-age test in `booking-create.test.ts` uses a DOB far below 18.)
- [ ] Typecheck: `npx tsc --noEmit`. Expected: clean.
- [ ] Commit: `git add src/lib/db/schema/settings.ts src/lib/admin/settings.ts src/test/admin-settings.test.ts drizzle && git commit -m "feat(settings): young-driver age band settings, minDriverAge default 18"`

---

### Task 2: `quote()` computes the young-driver line

**Files:**
- Modify: `src/lib/booking/quote.ts` (`QuoteInput` interface, `QuoteBreakdown` interface, `quote()` function; pre-wave lines 26-104, reshaped by plans 01/02)
- Test: `src/test/booking-quote.test.ts` (extend)

**Interfaces:**
- Consumes: `QuoteBreakdown.youngDriverCents: number` already exists (plan 02 seam, hardcoded 0). `bestVehicleCents` unchanged.
- Produces (seam + local):
  - `QuoteInput` gains `youngDriver?: boolean` (default false) and `youngDriverFeeCentsPerDay?: number` (default 0).
  - `QuoteBreakdown` gains `youngDriver: boolean` (the applied flag, snapshotted; local to this plan but read by Tasks 5, 6, 8) and `youngDriverCents` becomes computed: `youngDriver ? feePerDay * days : 0`.
  - `subtotalCents` = vehicle + insurance + add-ons + youngDriverCents. This single change carries the fee into plan 02's `paymentAmounts` (deposit percent and pay-now), Stripe checkout amounts, emails (they render `subtotalCents`), plan 06 contracts, plan 07 reports.

**Steps:**

- [ ] Open `src/lib/booking/quote.ts` and note the CURRENT shape of `QuoteInput` (plan 02 may have removed `reservationFeeCents`; plan 01 changed `rentalDays`). Then open `src/test/booking-quote.test.ts` and note how its existing `quote` tests construct input. The test code below constructs input WITHOUT `reservationFeeCents`; if the file's existing tests still pass it, add the same field with value `3000` to the three new calls so they compile.
- [ ] Write the failing tests. Append to `src/test/booking-quote.test.ts` (the `rates` const at the top of the file already exists, reuse it):

```ts
describe("quote young driver surcharge", () => {
  it("adds feePerDay times days and folds it into the subtotal", () => {
    const b = quote({ days: 7, vehicle: rates, addOns: [], currency: "USD", youngDriver: true, youngDriverFeeCentsPerDay: 1000 });
    expect(b.youngDriver).toBe(true);
    expect(b.youngDriverCents).toBe(7000);
    expect(b.subtotalCents).toBe(b.vehicleCents + b.insuranceCents + b.addOnsCents + 7000);
  });

  it("charges nothing when the flag is off or omitted", () => {
    const off = quote({ days: 7, vehicle: rates, addOns: [], currency: "USD", youngDriver: false, youngDriverFeeCentsPerDay: 1000 });
    expect(off.youngDriver).toBe(false);
    expect(off.youngDriverCents).toBe(0);
    const omitted = quote({ days: 7, vehicle: rates, addOns: [], currency: "USD" });
    expect(omitted.youngDriver).toBe(false);
    expect(omitted.youngDriverCents).toBe(0);
    expect(omitted.subtotalCents).toBe(omitted.vehicleCents + omitted.insuranceCents + omitted.addOnsCents);
  });

  it("keeps the flag true with a zero fee (surcharge disabled) without charging", () => {
    const b = quote({ days: 3, vehicle: rates, addOns: [], currency: "USD", youngDriver: true });
    expect(b.youngDriver).toBe(true);
    expect(b.youngDriverCents).toBe(0);
  });
});
```

- [ ] Run to verify failure: `npm test -- --no-file-parallelism src/test/booking-quote.test.ts`. Expected: TypeScript errors on the unknown `youngDriver` input fields, or assertion failures on `youngDriverCents`.
- [ ] Implement in `src/lib/booking/quote.ts`:
  1. In `QuoteInput`, add (after the `addOns` field):

```ts
  /** Young-driver surcharge (workstream 5). Flag decided server-side from the
   *  licence DOB at booking time; the wizard's claim only drives live quotes. */
  youngDriver?: boolean;
  youngDriverFeeCentsPerDay?: number;
```

  2. In `QuoteBreakdown`, next to the existing `youngDriverCents: number` field, add:

```ts
  /** True when the young-driver per-day fee was applied (snapshotted decision). */
  youngDriver: boolean;
```

  3. In the `quote()` function body, add before the returned object:

```ts
  const youngDriver = input.youngDriver ?? false;
  const youngDriverCents = youngDriver ? (input.youngDriverFeeCentsPerDay ?? 0) * days : 0;
```

  4. In the returned object: replace plan 02's hardcoded `youngDriverCents: 0` with `youngDriver,` and `youngDriverCents,`, and make the subtotal line read:

```ts
    subtotalCents: vehicleCents + insuranceCents + addOnsCents + youngDriverCents,
```

- [ ] Run to verify pass: `npm test -- --no-file-parallelism src/test/booking-quote.test.ts`. Expected: green.
- [ ] Run the full suite: `npm test -- --no-file-parallelism`. Expected: green. If a plan-02 test constructed a `QuoteBreakdown` literal and now misses the required `youngDriver` boolean, add `youngDriver: false` to that literal (mechanical fix, keep it minimal).
- [ ] Typecheck: `npx tsc --noEmit`. Expected: clean.
- [ ] Commit: `git add src/lib/booking/quote.ts src/test/booking-quote.test.ts && git commit -m "feat(quote): young-driver per-day surcharge line folded into subtotal"`

---

### Task 3: `driverAgeBand` classifier (pure policy helper)

**Files:**
- Modify: `src/lib/booking/license.ts` (add below `ageOn`, pre-wave line 31)
- Test: `src/test/booking-license.test.ts` (extend)

**Interfaces:**
- Consumes: `ageOn(dob: string, onDate: string): number` (same file, exists).
- Produces: `driverAgeBand(dob: string, pickupDate: string, s: { minDriverAge: number; youngDriverAge: number }): "under_min" | "young" | "standard"` and the exported type `DriverAgeBand`. Task 5 consumes both.

**Steps:**

- [ ] Write the failing tests. Append to `src/test/booking-license.test.ts` and add `driverAgeBand` to the existing import from `@/lib/booking/license`:

```ts
describe("driverAgeBand", () => {
  const s = { minDriverAge: 18, youngDriverAge: 21 };
  it("classifies under the minimum age", () => {
    expect(driverAgeBand("2010-01-01", "2026-07-01", s)).toBe("under_min");
    expect(driverAgeBand("2008-07-02", "2026-07-01", s)).toBe("under_min"); // 18th birthday one day after pick-up
  });
  it("classifies the young band, boundaries included", () => {
    expect(driverAgeBand("2008-07-01", "2026-07-01", s)).toBe("young"); // turns 18 on pick-up day
    expect(driverAgeBand("2005-07-02", "2026-07-01", s)).toBe("young"); // 20, turns 21 one day after pick-up
  });
  it("classifies standard at and above youngDriverAge", () => {
    expect(driverAgeBand("2005-07-01", "2026-07-01", s)).toBe("standard"); // turns 21 on pick-up day
    expect(driverAgeBand("1990-01-01", "2026-07-01", s)).toBe("standard");
  });
  it("an empty young band (youngDriverAge at or below minDriverAge) never returns young", () => {
    const flat = { minDriverAge: 21, youngDriverAge: 21 };
    expect(driverAgeBand("2007-01-01", "2026-07-01", flat)).toBe("under_min");
    expect(driverAgeBand("2000-01-01", "2026-07-01", flat)).toBe("standard");
  });
});
```

- [ ] Run to verify failure: `npm test -- --no-file-parallelism src/test/booking-license.test.ts`. Expected: import error, `driverAgeBand` is not exported.
- [ ] Implement in `src/lib/booking/license.ts`, directly below the `ageOn` function:

```ts
export type DriverAgeBand = "under_min" | "young" | "standard";

/**
 * Classify the main driver's age at pick-up against the operator's thresholds
 * (workstream 5). under_min hard-rejects (validateLicense), young pays the
 * per-day fee, standard pays nothing extra. Pure so it is trivially testable
 * and reusable at quote and create time.
 */
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
```

- [ ] Run to verify pass: `npm test -- --no-file-parallelism src/test/booking-license.test.ts`. Expected: green.
- [ ] Commit: `git add src/lib/booking/license.ts src/test/booking-license.test.ts && git commit -m "feat(booking): driverAgeBand classifier for the young-driver policy"`

---

### Task 4: Public quote carries the flag + `/api/booking-config` for the wizard labels

**Files:**
- Modify: `src/lib/booking/public.ts` (`QuoteRequest` interface and `publicQuote`, pre-wave lines 53-95; plus a new `publicBookingConfig`)
- Modify: `src/app/api/quote/route.ts` (`BodySchema`, pre-wave lines 11-17)
- Create: `src/app/api/booking-config/route.ts`
- Test: `src/test/young-driver.test.ts` (new file)

**Interfaces:**
- Consumes: Task 2's `quote()` input fields; `getSettings()`; seam "Quote request bodies gain optional `youngDriver: boolean`".
- Produces:
  - `QuoteRequest.youngDriver?: boolean`; `publicQuote` prices it with `settings.youngDriverFeeCentsPerDay`.
  - `publicBookingConfig(): Promise<PublicBookingConfig>` where `PublicBookingConfig = { minDriverAge: number; youngDriverAge: number; youngDriverFeeCentsPerDay: number; currency: string }`.
  - `GET /api/booking-config` returning that object as JSON. Task 8 (wizard) consumes it for the age-selector labels.

**Steps:**

- [ ] BEFORE writing test code, open `src/lib/booking/public.ts` and check the CURRENT `QuoteRequest` field names and `publicQuote` signature. Plan 01 renamed the date fields to `startAt`/`endAt` (accepting ISO datetime, with date-only values still valid) and may have dropped the `today` parameter. The code below is written for the post-plan-01 shape (`startAt`/`endAt`, `publicQuote(req, today)`); if the file differs (for example `today` was removed or the fields kept their old names), use the file's actual shape in the test helper and keep every assertion identical.
- [ ] Write the failing test. Create `src/test/young-driver.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, settings } from "@/lib/db/schema";
import { publicQuote, publicBookingConfig } from "@/lib/booking/public";

let db: Awaited<ReturnType<typeof getDb>>;

// Injected "today" mirroring booking-create.test.ts. If plan 01 removed the
// today parameter from publicQuote/createBooking, drop it from the calls only.
const TODAY = "2026-06-15";
const START = "2027-02-01T09:00:00-04:00";
const END = "2027-02-08T09:00:00-04:00"; // 7 rental days

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
  // Pin the values this suite depends on; earlier test files share the database
  // and may have patched settings.
  await db.update(settings)
    .set({ minDriverAge: 18, youngDriverAge: 21, youngDriverFeeCentsPerDay: 1000 })
    .where(eq(settings.id, 1));
  await db.insert(vehicles).values({
    slug: "yd-car", plate: "PL-yd-car", class: "SUV", name: "YD Car", seats: 5, transmission: "Automatic",
    doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000, depositCents: 25000,
  });
});

describe("publicBookingConfig", () => {
  it("exposes the non-sensitive age-band settings for the wizard", async () => {
    const cfg = await publicBookingConfig();
    expect(cfg.minDriverAge).toBe(18);
    expect(cfg.youngDriverAge).toBe(21);
    expect(cfg.youngDriverFeeCentsPerDay).toBe(1000);
    expect(typeof cfg.currency).toBe("string");
    // nothing else leaks (no admin recipients, no retention settings)
    expect(Object.keys(cfg).sort()).toEqual(["currency", "minDriverAge", "youngDriverAge", "youngDriverFeeCentsPerDay"]);
  });
});

describe("publicQuote young driver", () => {
  it("prices the fee when the claimed band is young", async () => {
    const b = await publicQuote({ vehicleSlug: "yd-car", startAt: START, endAt: END, youngDriver: true }, TODAY);
    expect(b.youngDriver).toBe(true);
    expect(b.youngDriverCents).toBe(7 * 1000);
    expect(b.subtotalCents).toBe(b.vehicleCents + b.insuranceCents + b.addOnsCents + 7000);
  });

  it("prices no fee when the flag is omitted", async () => {
    const b = await publicQuote({ vehicleSlug: "yd-car", startAt: START, endAt: END }, TODAY);
    expect(b.youngDriver).toBe(false);
    expect(b.youngDriverCents).toBe(0);
  });
});
```

- [ ] Run to verify failure: `npm test -- --no-file-parallelism src/test/young-driver.test.ts`. Expected: import error, `publicBookingConfig` is not exported (and/or unknown `youngDriver` property on `QuoteRequest`).
- [ ] Implement in `src/lib/booking/public.ts`:
  1. Add to the `QuoteRequest` interface (after its last existing field):

```ts
  /** Claimed age band from the wizard selector; drives the live quote only.
   *  createBooking re-derives the truth from the licence DOB. */
  youngDriver?: boolean;
```

  2. In `publicQuote`, add two properties to the existing `quote({ ... })` call object (the call at the end of the function):

```ts
    youngDriver: req.youngDriver ?? false,
    youngDriverFeeCentsPerDay: settings.youngDriverFeeCentsPerDay,
```

  3. Add at the end of the file:

```ts
export interface PublicBookingConfig {
  minDriverAge: number;
  youngDriverAge: number;
  youngDriverFeeCentsPerDay: number;
  currency: string;
}

/** Non-sensitive booking settings the wizard needs before it can quote
 *  (workstream 5: the driver-age selector labels derive from these). */
export async function publicBookingConfig(): Promise<PublicBookingConfig> {
  const s = await getSettings();
  return {
    minDriverAge: s.minDriverAge,
    youngDriverAge: s.youngDriverAge,
    youngDriverFeeCentsPerDay: s.youngDriverFeeCentsPerDay,
    currency: s.currency,
  };
}
```

- [ ] Modify `src/app/api/quote/route.ts`: add to `BodySchema` (before `.strict()`):

```ts
  youngDriver: z.boolean().optional(),
```

- [ ] Create `src/app/api/booking-config/route.ts`:

```ts
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { publicBookingConfig } from "@/lib/booking/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/booking-config — public, non-sensitive settings the booking wizard
 *  needs before it can quote (driver age bands and the young-driver fee). */
export const GET = withRoute(async (req) => {
  await enforceRateLimit(req, "global", "public");
  return json(await publicBookingConfig(), req);
});
```

- [ ] Run to verify pass: `npm test -- --no-file-parallelism src/test/young-driver.test.ts`. Expected: green.
- [ ] Typecheck and lint: `npx tsc --noEmit && npm run lint`. Expected: clean.
- [ ] Commit: `git add src/lib/booking/public.ts src/app/api/quote/route.ts src/app/api/booking-config/route.ts src/test/young-driver.test.ts && git commit -m "feat(booking): young-driver flag on public quotes + booking-config endpoint"`

---

### Task 5: `createBooking` DOB truth-check, transparent reprice, `priceAdjusted`

**Files:**
- Modify: `src/lib/booking/create.ts` (`BookingCreateSchema` pre-wave lines 26-41, `BookingResult` pre-wave lines 46-50, `createBooking` body: replay block pre-wave lines 56-59, guardrails block pre-wave lines 65-70, `quote({...})` call pre-wave lines 114-129, both replay returns pre-wave lines 198 and 200-209)
- Modify: `src/app/api/bookings/route.ts` (the `json({...})` response, pre-wave lines 26-34)
- Test: `src/test/young-driver.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2 `quote()` fields, Task 3 `driverAgeBand`, existing `validateLicense` (hard under-age reject stays untouched), `getSettings()`.
- Produces (seam): `createBooking` recomputes from DOB truth; mismatch creates the booking with the CORRECTED snapshot and the API response includes `priceAdjusted: true`. Concretely: `BookingResult` gains `priceAdjusted: boolean`; `BookingCreateSchema` gains `youngDriver: z.boolean().optional().default(false)`; `POST /api/bookings` response JSON gains `priceAdjusted`. Task 8 (wizard) consumes the response field.

**Steps:**

- [ ] BEFORE writing code, open `src/lib/booking/create.ts` and find (a) the current name of the start field on the input (`startDate` pre-wave; `startAt` after plan 01) and (b) the `validateLicense(input.license, { minDriverAge: ..., rentalStart: ..., rentalEnd: ... })` call. The expression passed as `rentalStart` is the pickup date string this task reuses. Post plan 01 it is the date part of the start timestamp, i.e. `input.startAt.slice(0, 10)`; pre-wave it was `input.startDate`.
- [ ] Write the failing tests. Append to `src/test/young-driver.test.ts` (extend the file's imports: add `bookings` to the schema import, and add the two new imports shown). Mirror `booking-create.test.ts` for the `createBooking` call shape; if plan 01 renamed the schema's date fields, rename them in this helper only:

```ts
import { createBooking, type BookingCreateInput } from "@/lib/booking/create";
import type { QuoteBreakdown } from "@/lib/booking/quote";

const baseLicense = {
  nameOnLicense: "Yara Young", licenseNumber: "AUA-9990001", issuingCountry: "Aruba",
  issueDate: "2026-01-01", expiryDate: "2036-01-01", dob: "2008-01-15", // 19 at the 2027-02-01 pick-up
};

function ydInput(over: Partial<BookingCreateInput> = {}): BookingCreateInput {
  return {
    vehicleSlug: "yd-car", startAt: START, endAt: END,
    customer: { email: "yara@example.com", name: "Yara Young", phone: "+297 000 1111" },
    insuranceTierId: null, addOns: [], license: { ...baseLicense },
    acceptTerms: true, paymentOption: "deposit",
    youngDriver: false,
    idempotencyKey: "yd-" + Math.random().toString(36).slice(2),
    ...over,
  } as BookingCreateInput;
}

describe("createBooking young-driver truth check", () => {
  it("honest young claim: fee applied, no adjustment flag", async () => {
    const { booking, breakdown, priceAdjusted } = await createBooking(
      ydInput({ youngDriver: true, idempotencyKey: "yd-honest-1" }), TODAY);
    expect(priceAdjusted).toBe(false);
    expect(breakdown.youngDriver).toBe(true);
    expect(breakdown.youngDriverCents).toBe(7000);
    const snap = booking.priceBreakdown as QuoteBreakdown;
    expect(snap.youngDriver).toBe(true);
    expect(snap.youngDriverCents).toBe(7000);
    expect(snap.subtotalCents).toBe(snap.vehicleCents + snap.insuranceCents + snap.addOnsCents + 7000);
  });

  it("claimed standard but DOB says young: booking created, repriced up, priceAdjusted true", async () => {
    const { breakdown, priceAdjusted } = await createBooking(
      ydInput({ youngDriver: false, startAt: "2027-03-01T09:00:00-04:00", endAt: "2027-03-08T09:00:00-04:00", idempotencyKey: "yd-up-1" }), TODAY);
    expect(priceAdjusted).toBe(true);
    expect(breakdown.youngDriver).toBe(true);
    expect(breakdown.youngDriverCents).toBe(7000);
  });

  it("claimed young but DOB says standard: fee dropped, priceAdjusted true", async () => {
    const { breakdown, priceAdjusted } = await createBooking(
      ydInput({
        youngDriver: true,
        license: { ...baseLicense, licenseNumber: "AUA-9990002", dob: "2000-05-17" }, // 26 at pick-up
        customer: { email: "olga@example.com", name: "Olga Older", phone: "+297 000 2222" },
        startAt: "2027-04-01T09:00:00-04:00", endAt: "2027-04-08T09:00:00-04:00",
        idempotencyKey: "yd-down-1",
      }), TODAY);
    expect(priceAdjusted).toBe(true);
    expect(breakdown.youngDriver).toBe(false);
    expect(breakdown.youngDriverCents).toBe(0);
  });

  it("under minDriverAge still hard-rejects", async () => {
    await expect(createBooking(
      ydInput({ license: { ...baseLicense, dob: "2010-06-01" }, idempotencyKey: "yd-under-1" }), TODAY),
    ).rejects.toThrow(/at least 18/i);
  });

  it("idempotent replay reports the same adjustment against the same claim", async () => {
    const first = await createBooking(
      ydInput({ youngDriver: false, startAt: "2027-05-01T09:00:00-04:00", endAt: "2027-05-08T09:00:00-04:00", idempotencyKey: "yd-replay-1" }), TODAY);
    expect(first.priceAdjusted).toBe(true);
    const again = await createBooking(
      ydInput({ youngDriver: false, startAt: "2027-05-01T09:00:00-04:00", endAt: "2027-05-08T09:00:00-04:00", idempotencyKey: "yd-replay-1" }), TODAY);
    expect(again.replayed).toBe(true);
    expect(again.booking.id).toBe(first.booking.id);
    expect(again.priceAdjusted).toBe(true); // still true for the same wrong claim
  });
});
```

- [ ] Run to verify failure: `npm test -- --no-file-parallelism src/test/young-driver.test.ts`. Expected: TypeScript errors (`youngDriver` not in `BookingCreateInput`, `priceAdjusted` not on the result).
- [ ] Implement in `src/lib/booking/create.ts`:
  1. Import the classifier: extend the existing import from `@/lib/booking/license` with `driverAgeBand`.
  2. In `BookingCreateSchema`, add after the `paymentOption` line:

```ts
  // Claimed age band from the wizard selector. A hint only: the licence DOB is
  // the truth and createBooking reprices on mismatch (priceAdjusted).
  youngDriver: z.boolean().optional().default(false),
```

  3. In `BookingResult`, add:

```ts
  /** True when the claimed age band did not match the licence DOB and the
   *  snapshot was corrected (up or down) before payment. */
  priceAdjusted: boolean;
```

  4. In the early idempotent-replay block (`if (existing) { ... }` near the top), return the recomputed flag (old snapshots without the field count as not-young):

```ts
  if (existing) {
    const prior = existing.priceBreakdown as QuoteBreakdown;
    return {
      booking: existing,
      breakdown: prior,
      replayed: true,
      priceAdjusted: (prior.youngDriver ?? false) !== input.youngDriver,
    };
  }
```

  5. Directly after the `validateLicense(...)` call (which keeps the under-`minDriverAge` hard reject), add the truth check. `pickupDateStr` is the SAME expression the file passes to `validateLicense` as `rentalStart` (post plan 01: `input.startAt.slice(0, 10)`); factor it into a local const above the `validateLicense` call and use it in both places:

```ts
  // Young-driver truth check (workstream 5): the licence DOB decides the
  // surcharge, never the claimed band. under_min never reaches here.
  const band = driverAgeBand(input.license.dob, pickupDateStr, settings);
  const youngDriver = band === "young";
  const priceAdjusted = youngDriver !== input.youngDriver;
```

  6. In the `quote({ ... })` call, add two properties:

```ts
    youngDriver,
    youngDriverFeeCentsPerDay: settings.youngDriverFeeCentsPerDay,
```

  7. The transaction's success return becomes:

```ts
      return { booking: booking!, breakdown, replayed: false, priceAdjusted };
```

  8. In the `catch` block's unique-violation replay (`if (winner) return ...`), mirror step 4:

```ts
      if (winner) {
        const prior = winner.priceBreakdown as QuoteBreakdown;
        return {
          booking: winner,
          breakdown: prior,
          replayed: true,
          priceAdjusted: (prior.youngDriver ?? false) !== input.youngDriver,
        };
      }
```

- [ ] Modify `src/app/api/bookings/route.ts`: destructure and echo the new flag. Change the `createBooking` line to `const { booking, breakdown, replayed, priceAdjusted } = await createBooking(input, arubaToday());` and add `priceAdjusted,` as a property of the existing `json({ ... })` response object (leave every other property exactly as it is).
- [ ] Run to verify pass: `npm test -- --no-file-parallelism src/test/young-driver.test.ts`. Expected: green.
- [ ] Run the full suite: `npm test -- --no-file-parallelism`. Expected: green (existing `booking-create.test.ts` calls omit `youngDriver`, which defaults to false; its adult test DOBs make `priceAdjusted` false and nothing there asserts the new field).
- [ ] Typecheck: `npx tsc --noEmit`. Expected: clean.
- [ ] Commit: `git add src/lib/booking/create.ts src/app/api/bookings/route.ts src/test/young-driver.test.ts && git commit -m "feat(booking): DOB truth-check reprice with priceAdjusted flag in createBooking"`

---

### Task 6: Rental extension re-quote preserves the young-driver fee

**Files:**
- Modify: `src/lib/admin/extend-booking.ts` (created by plan 02; anchor: the `quote({ ... })` call that prices the full new duration, whose result feeds `delta = max(0, newQuote.subtotalCents - oldSnapshot.subtotalCents)`)
- Test: `src/test/young-driver.test.ts` (extend)

**Interfaces:**
- Consumes (seam, verbatim): `extendBooking(bookingId, { endAt, payment: 'link'|'desk', actor })` from `src/lib/admin/extend-booking.ts`; delta = `max(0, newQuote.subtotalCents − oldSnapshot.subtotalCents)`. Also Task 2's quote fields and the snapshot `youngDriver` flag.
- Produces: the extension's replacement snapshot keeps `youngDriver`/`youngDriverCents` correct for the NEW day count (a young driver extending from 3 to 5 days owes fee for 5 days; delta pricing then includes the extra fee days automatically).

**Steps:**

- [ ] Open `src/lib/admin/extend-booking.ts` and locate two things: (a) the variable holding the original snapshot (`booking.priceBreakdown as QuoteBreakdown` or similar, used for the delta subtraction) and (b) the `quote({ ... })` call for the new duration. Also note the exact `actor` parameter type (plan 02 defined it; it is an admin identifier passed through to the audit log).
- [ ] Write the failing test. Append to `src/test/young-driver.test.ts` (add `adminUsers` to the schema import and import `extendBooking` from `@/lib/admin/extend-booking`; if the `actor` argument is an object rather than an id in plan 02's signature, pass the file's actual shape, everything else stays identical):

```ts
describe("extendBooking keeps the young-driver fee", () => {
  it("re-quotes the full new duration with the snapshotted flag", async () => {
    const { booking } = await createBooking(ydInput({
      youngDriver: true,
      startAt: "2027-06-01T09:00:00-04:00", endAt: "2027-06-04T09:00:00-04:00", // 3 days
      idempotencyKey: "yd-extend-1",
    }), TODAY);
    await db.update(bookings).set({ status: "confirmed" }).where(eq(bookings.id, booking.id));
    const [admin] = await db.insert(adminUsers)
      .values({ email: "yd-admin@test.local", passwordHash: "test-only" }).returning();

    await extendBooking(booking.id, {
      endAt: "2027-06-06T09:00:00-04:00", // now 5 days
      payment: "desk",
      actor: admin!.id,
    });

    const [updated] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    const snap = updated!.priceBreakdown as QuoteBreakdown;
    expect(snap.youngDriver).toBe(true);
    expect(snap.youngDriverCents).toBe(5 * 1000);
    expect(snap.subtotalCents).toBe(snap.vehicleCents + snap.insuranceCents + snap.addOnsCents + 5000);
  });
});
```

- [ ] Run to verify failure: `npm test -- --no-file-parallelism src/test/young-driver.test.ts`. Expected: the new test fails with `snap.youngDriver` false / `youngDriverCents` 0 (the plan 02 re-quote never passed the flag, so `quote()` defaults it off).
- [ ] Implement in `src/lib/admin/extend-booking.ts`: add two properties to the new-duration `quote({ ... })` call, reading the flag from the ORIGINAL snapshot variable identified above (shown here as `oldBreakdown`; use the file's actual variable name) and the fee from the settings object the function already loads:

```ts
    youngDriver: (oldBreakdown as QuoteBreakdown).youngDriver ?? false,
    youngDriverFeeCentsPerDay: settings.youngDriverFeeCentsPerDay,
```

- [ ] Run to verify pass: `npm test -- --no-file-parallelism src/test/young-driver.test.ts`. Expected: green.
- [ ] Run the full suite: `npm test -- --no-file-parallelism`. Expected: green (plan 02's own extension tests used adult snapshots where `youngDriver ?? false` is false, so their deltas are unchanged).
- [ ] Typecheck: `npx tsc --noEmit`. Expected: clean.
- [ ] Commit: `git add src/lib/admin/extend-booking.ts src/test/young-driver.test.ts && git commit -m "fix(admin): extension re-quote preserves the young-driver surcharge"`

---

### Task 7: Settings page fields (admin UI)

**Files:**
- Modify: `src/app/admin/(shell)/settings/page.tsx` (the `Settings` interface at pre-wave lines 16-20, the `save()` PATCH body at pre-wave lines 67-77, the form grid at pre-wave lines 156-193, the skeleton count at pre-wave line 125)

**Interfaces:**
- Consumes: Task 1's `SettingsPatchSchema` fields via the existing `PATCH /api/admin/settings` route (no route change needed, the route already forwards the whole patch); `apiGet`/`apiPatch` from `src/app/admin/client.ts`; the page's existing `dollars` helper.
- Produces: owner-editable Young driver age threshold and Young driver fee per day. No new seams.

**Steps:**

- [ ] Implement, three edits to `src/app/admin/(shell)/settings/page.tsx` (plans 01/02/03 already added their own fields here; slot these in after the Minimum driver age field wherever it now sits):
  1. Extend the local `Settings` interface with:

```ts
  youngDriverAge: number; youngDriverFeeCentsPerDay: number;
```

  2. In the `save()` handler's `apiPatch` body object, add:

```ts
        youngDriverAge: s.youngDriverAge,
        youngDriverFeeCentsPerDay: s.youngDriverFeeCentsPerDay,
```

  3. In the form grid, directly after the `Minimum driver age` label block, add:

```tsx
              <label>Young driver age threshold (under this pays the fee)
                <input type="number" min="16" max="99" value={s.youngDriverAge}
                  onChange={(e) => setS({ ...s, youngDriverAge: Number(e.target.value) })} />
              </label>
              <label>Young driver fee per day ({s.currency})
                <input type="number" step="0.01" min="0" value={dollars(s.youngDriverFeeCentsPerDay)}
                  onChange={(e) => setS({ ...s, youngDriverFeeCentsPerDay: Math.round(Number(e.target.value) * 100) })} />
              </label>
```

  4. Bump the loading-skeleton field count in the `Fees &amp; guardrails` skeleton block by 2 (pre-wave it was `Array.from({ length: 9 })`; increase whatever the current number is by 2).
- [ ] Typecheck and lint: `npx tsc --noEmit && npm run lint`. Expected: clean.
- [ ] Manual verification: run `npm run dev`, sign in at `http://localhost:3000/admin/login` (create a dev admin with `npm run admin:create` if none exists), open `http://localhost:3000/admin/settings`. Check: the two new fields render after Minimum driver age with values 21 and 10 (dollars); change the fee to 12.50, Save settings, reload, the value persists as 12.50. Set it back to 10 and save. Stop the dev server before any later build.
- [ ] Commit: `git add "src/app/admin/(shell)/settings/page.tsx" && git commit -m "feat(admin): young-driver age and fee fields on the settings page"`

---

### Task 8: Wizard age selector, live quote flag, price-update notice (public UI)

**Files:**
- Modify: `src/app/(public)/book/page.tsx` (landmarks, pre-wave numbering: `Breakdown` interface lines 9-13, catalog-load effect lines 43-58, quote effect lines 83-90, `submit()` lines 92-114, `validateStep` lines 137-166, step 2 card lines 262-273, step 7 recap `dl` lines 341-349, final-step notes lines 382-387, summary sidebar lines 392-406. Plans 01 and 02 reshaped step 2, step 7, and `submit()`; anchor on the landmarks named in each edit, not on line numbers.)

**Interfaces:**
- Consumes: `GET /api/booking-config` (Task 4) returning `{ minDriverAge, youngDriverAge, youngDriverFeeCentsPerDay, currency }`; `POST /api/quote` accepting `youngDriver` (Task 4); `POST /api/bookings` returning `priceAdjusted` and the corrected `breakdown` (Task 5); the booking idempotency behavior (same `idempotencyKey` replays the same booking), which makes the two-click confirm flow safe.
- Produces: UI only, no new seams.

**Steps:**

- [ ] Implement in `src/app/(public)/book/page.tsx`, seven edits:
  1. Extend the local `Breakdown` interface with the two new fields:

```ts
  youngDriver: boolean; youngDriverCents: number;
```

  2. Add state near the other wizard state declarations:

```ts
  const [cfg, setCfg] = useState({ minDriverAge: 18, youngDriverAge: 21, youngDriverFeeCentsPerDay: 0 });
  const [driverAge, setDriverAge] = useState<"" | "young" | "standard">("");
  const [priceNotice, setPriceNotice] = useState("");
  const priceAcknowledged = useRef(false);
```

  (`useRef` is already imported.)
  3. In the initial catalog-load `useEffect`, add a config fetch alongside the existing ones (do not add it to the `Promise.all` tuple, keep it independent so a config hiccup cannot block the fleet):

```ts
    fetch("/api/booking-config")
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => { if (c) setCfg(c); })
      .catch(() => {});
```

  4. In the live-quote `useEffect`, add `youngDriver: driverAge === "young"` to the request `body` object and add `driverAge` to the effect's dependency array.
  5. In the step 2 card, after the pick-up and return fields (post plan 01 these include TimeSelect controls; place this block after them, before the availability message), add the selector. Copy is dash-free:

```tsx
                <div className="age-band" role="radiogroup" aria-label="Main driver's age">
                  <p className="note" style={{ marginBottom: 6 }}>Main driver&apos;s age</p>
                  <label className="opt">
                    <input type="radio" name="driver-age" checked={driverAge === "young"}
                      onChange={() => { setDriverAge("young"); setStepError(""); }} />
                    <span className="grow">Age {cfg.minDriverAge} to {cfg.youngDriverAge - 1}</span>
                    {cfg.youngDriverFeeCentsPerDay > 0 && (
                      <span className="price">{money(cfg.youngDriverFeeCentsPerDay, cur)}/day</span>
                    )}
                  </label>
                  <label className="opt">
                    <input type="radio" name="driver-age" checked={driverAge === "standard"}
                      onChange={() => { setDriverAge("standard"); setStepError(""); }} />
                    <span className="grow">Age {cfg.youngDriverAge} or older</span>
                  </label>
                </div>
```

  6. In `validateStep`, inside the `if (n === 2)` block, after the existing date checks, add:

```ts
      if (!driverAge) return "Please tell us the main driver's age so we can show the right price.";
```

  7. Wire the transparent reprice into `submit()`. Directly after the existing `if (!res.ok) { ... }` guard on the `POST /api/bookings` response, add:

```ts
      if (data.priceAdjusted && !priceAcknowledged.current) {
        priceAcknowledged.current = true;
        if (data.breakdown) setBreakdown(data.breakdown);
        setPriceNotice(
          data.breakdown?.youngDriverCents > 0
            ? "We checked the driver's date of birth on the licence and added the young driver fee. Your updated total is shown in the summary. Tap the button again to confirm and pay."
            : "We checked the driver's date of birth on the licence and the young driver fee does not apply. Your updated, lower total is shown in the summary. Tap the button again to confirm and pay.",
        );
        setBusy(false);
        return;
      }
```

  (Second tap replays the same booking via the unchanged `idempotencyKey` and proceeds to checkout; the snapshot was already corrected server-side, so Stripe charges the honest amount either way.)
  8. Render the notice on the final step, next to the existing error paragraph inside the `step === TOTAL` block:

```tsx
              {priceNotice && <p className="msg price-notice" role="status" aria-live="polite">{priceNotice}</p>}
```

  9. Surface the fee line and the recap row. In the summary sidebar, after the insurance line, add:

```tsx
            {breakdown.youngDriverCents > 0 && (
              <div className="line"><span>Young driver fee</span><span>{money(breakdown.youngDriverCents, cur)}</span></div>
            )}
```

  And in the step 7 recap `dl` (plan 02 rebuilt this step; put it after the Driver row), add:

```tsx
                  <div className="recap-row"><dt>Driver age</dt><dd>{driverAge === "young" ? `${cfg.minDriverAge} to ${cfg.youngDriverAge - 1}` : driverAge === "standard" ? `${cfg.youngDriverAge} or older` : "Not set"}</dd></div>
```

- [ ] Typecheck and lint: `npx tsc --noEmit && npm run lint`. Expected: clean.
- [ ] Manual verification: with `npm run dev` running and the DB seeded (`npm run db:seed` if empty), open `http://localhost:3000/book`. Check: (1) step 2 shows the "Main driver's age" radios reading "Age 18 to 20" (with a per-day price tag) and "Age 21 or older"; (2) Continue without picking an age shows the inline message; (3) pick dates plus "Age 18 to 20" and the summary sidebar gains a "Young driver fee" line and a higher total; (4) switch to "Age 21 or older" and the line disappears. Full reprice-notice verification (needs Stripe keys) happens in Task 9. Stop the dev server before any later build.
- [ ] Commit: `git add "src/app/(public)/book/page.tsx" && git commit -m "feat(book): driver age selector, live young-driver quote, transparent price-update notice"`

---

### Task 9: Wire-through verification (no new code)

**Files:**
- Read only. Fix-forward only if a check fails, in the file that fails.

**Interfaces:**
- Consumes: everything above. Confirms the spec claim "flows into subtotal, deposit %, Stripe amount, emails, contract" without further edits.

**Steps:**

- [ ] Verify payments derive from subtotal (so the fee is inside deposit and pay-now): run `grep -n "subtotalCents" src/lib/payments/charge.ts src/lib/payments/checkout.ts`. Expected: `paymentAmounts` in `charge.ts` computes from `breakdown.subtotalCents` (plan 02 seam). If checkout instead reads a field that excludes the fee, stop and fix `charge.ts` to use `subtotalCents`, then rerun the payment tests: `npm test -- --no-file-parallelism src/test/payments-charge.test.ts`.
- [ ] Verify emails inherit the fee: run `grep -n "subtotalCents" src/lib/email/notifications.ts`. Expected: the confirmation email's rental total is `breakdown.subtotalCents` (pre-wave line 69 precedent). No change needed when found.
- [ ] Verify no plaintext DOB leaks were introduced: run `grep -rn "license.dob" src/lib/booking/create.ts`. Expected: matches only inside `driverAgeBand(...)`/`validateLicense(...)`/`encryptLicense(...)` call flow, never in a return value, log, or snapshot. The existing `never returns licence plaintext` test in `booking-create.test.ts` plus the snapshot assertions in `young-driver.test.ts` guard this; both must be green.
- [ ] Run the complete gate: `npm test -- --no-file-parallelism && npx tsc --noEmit && npm run lint`. Expected: all green, zero type errors, zero lint errors.
- [ ] Optional end-to-end (only if `STRIPE_SECRET_KEY` test keys are configured in `.env.local`): `npm run dev`, book at `http://localhost:3000/book` claiming "Age 21 or older" while entering a licence DOB 19 years back at the licence step; on Reserve, the price-update notice appears with the raised total; second tap redirects to Stripe showing the raised pay-now amount. Cancel at Stripe; do not complete a charge. Stop the dev server.
- [ ] No commit for this task unless a check forced a fix; if it did, commit that fix as `git add <changed files> && git commit -m "fix(payments): young-driver fee wire-through correction"`.
