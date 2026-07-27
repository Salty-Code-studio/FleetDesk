# Payment Redesign + Rental Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the misleading three-way payment options with an honest deposit-or-full model (with auto-refund cancellation, admin refunds, rental extensions with delta payments, and a BookingDrawer as the primary admin booking surface), so the number Stripe charges always exactly matches what the customer was shown.

**Architecture:** Money amounts are computed by one pure helper (`paymentAmounts` in `src/lib/payments/charge.ts`) from settings values snapshotted onto each booking's `priceBreakdown`; the Stripe webhook remains the single money-truth flip and now also maintains `bookings.amount_paid_cents`. Extensions apply immediately (DB exclusion constraint holds the car) and collect the delta via a Stripe Checkout link or a desk payment row. The admin planning board's booking popover is replaced by a right-side BookingDrawer that shows summary, payments (paid/balance), and actions (Move, Cancel with refund choice, Extend).

**Tech Stack:** Next.js 15 App Router (route handlers), Drizzle ORM (PGlite dev/test, Supabase Postgres prod), zod at every boundary, Stripe hosted Checkout + signed webhooks, Resend email, vitest.

## Global Constraints

- Tests: `npm test -- --no-file-parallelism` (vitest). New features land with tests.
- NEVER `npm run build` while a `next dev` server is running (shared `.next` corrupts).
- Migrations: `npm run db:generate` for drizzle diffs; hand-written SQL files in `./drizzle` for constraints/enum surgery (precedent: 0002, 0007, 0010). Applied with `npm run db:migrate`. Must work on BOTH PGlite (`pglite://`, dev/test) and Postgres (Supabase prod).
- Admin mutations go through `mutate(req, action, fn)` from `src/lib/admin/guard.ts` (audit-logged); reads through `read(req, fn)`.
- Admin UI: reuse `Modal, Drawer, useToast, useConfirm, Skeleton, EmptyState, registerPaletteAction` from `@/app/admin/_ui` and `DatePicker, Select` from `@/components/ui`. Strict CSP: no external assets ever. Money is integer cents.
- Copy: dash-free house style (no em-dashes), warm/human tone.
- Timezone: operator-local day logic uses `America/Aruba` (existing `arubaToday()` precedent).
- Design principle: less clicking. One click from a planning bar opens the BookingDrawer with everything in it.
- Workstream 2 specifics from the spec: the number Stripe shows must EXACTLY match the "You pay now" line (the number one trust fix). The vehicle security deposit (borg, `vehicles.depositCents` / `breakdown.depositCents`) is NEVER charged online anymore; it is an at-pickup information line, clearly labeled refundable. The card-charging "cash deposit" option is removed entirely.

## Execution context (read before every task)

Plan 01 (`2026-07-27-wave-01-time-foundation.md`) is already merged when this plan runs. That means the codebase you find differs from pre-wave descriptions in these ways (all names are canonical, from `docs/superpowers/plans/SEAMS-2026-07-wave.md`):

- `bookings` columns are `start_at` / `end_at` / `buffer_end_at` timestamptz with drizzle `mode: "string"` (drizzle properties `startAt` / `endAt` / `bufferEndAt`, JS STRING values: insert ISO strings like `atAruba("2026-08-01","09:00")`; reads come back in Postgres text form, parse with `parseTs` from `@/lib/time/format`, never `.getTime()` on the raw column). Semantics `[startAt, endAt)` preserved. Booking status enum already contains `picked_up`.
- `settings` has `turnaroundBufferHours` (int), `openingTime`, `closingTime`.
- `src/lib/validation/iso-date.ts` exports `isoDateTime` (ISO 8601 with offset) next to `isoDate`.
- `src/lib/time/format.ts` exports `formatDateTime(iso: string): string` (Aruba TZ, e.g. "Aug 1, 2026 at 09:00"). ALL user-facing period rendering goes through it.
- `rentalDays(startAt: string, endAt: string)` in `src/lib/booking/quote.ts` takes ISO datetime strings.
- `src/components/ui` exports `TimeSelect` (`value: "HH:MM"`, `onChange`, `min`, `max`, 30-min steps).
- Test fixtures that insert bookings pass ISO strings: `startAt: atAruba("2026-08-01", "09:00")` (equals 13:00Z). Wherever a step below writes `startAt: new Date(X)`, pass the ISO string instead; wherever it reads timestamps numerically, wrap with `parseTs(...)`.

Where a step below quotes "current" code from a file plan 01 also touched, the surrounding lines may have shifted or been reworded; anchor on the quoted fragment, not on line numbers. Where a quoted fragment includes date handling that plan 01 rewrote, keep plan 01's version of the date handling and apply ONLY the payment-related change described. Work on branch `feat/wave-2026-07`.

---

### Task 1: Money model migration + charge core

The single biggest task: retire `reservation_fee | full_deposit | cash_deposit`, introduce `deposit | full`, snapshot deposit settings into every quote, add `bookings.amount_paid_cents`, and give payments a `method` (stripe/desk) plus refund tracking. Everything that writes or reads a payment-option literal is updated in this one task so the repo compiles and the suite is green at the end.

**Files:**
- Modify: `src/lib/db/schema/bookings.ts` (paymentOption enum, new column)
- Modify: `src/lib/db/schema/payments.ts` (full replacement below)
- Modify: `src/lib/db/schema/settings.ts` (three settings columns)
- Create: next drizzle migration (generated, then body replaced with the SQL below)
- Modify: `src/lib/booking/quote.ts` (QuoteInput/QuoteBreakdown fields)
- Modify: `src/lib/payments/charge.ts` (full replacement below)
- Modify: `src/lib/booking/create.ts`, `src/lib/booking/public.ts`, `src/lib/admin/move-booking.ts`, `src/lib/admin/manual-booking.ts`, `src/lib/admin/settings.ts`, `src/lib/payments/checkout.ts`, `src/lib/email/templates.ts`, `src/app/(public)/book/page.tsx`
- Test: rewrite `src/test/payments-charge.test.ts`; mechanical sweep of 13 other test files listed below

**Interfaces:**
- Consumes: `QuoteBreakdown` from `src/lib/booking/quote.ts`; `settings` singleton via `getSettings()`.
- Produces (later tasks and later plans rely on these exact names):
  - `type PaymentOption = "deposit" | "full"` in `src/lib/payments/charge.ts`
  - `type ChargeType = "reservation_fee" | "deposit" | "rental_deposit" | "rental_full" | "extension"` (the first two exist only on historical rows)
  - `interface DepositSettings { depositPercent: number; depositMinCents: number }`
  - `interface PaymentAmounts { payNowCents: number; balanceDueCents: number }`
  - `paymentAmounts(breakdown: QuoteBreakdown, option: PaymentOption, settings: DepositSettings): PaymentAmounts`
  - `depositSettingsFromSnapshot(breakdown: QuoteBreakdown): DepositSettings`
  - `chargeForBooking(paymentOption: PaymentOption, breakdown: QuoteBreakdown): Charge`
  - `QuoteBreakdown` gains `youngDriverCents: number` (always 0 in this plan; plan 05 wires it), `depositPercent: number`, `depositMinCents: number`; loses `reservationFeeCents`
  - Schema: `bookings.amountPaidCents` (`amount_paid_cents` int NOT NULL default 0), `payments.method` (`payment_method` enum `stripe|desk`, default stripe), `payments.refundedCents` (`refunded_cents` int NOT NULL default 0), `payment_type` enum gains `rental_deposit`, `rental_full`, `extension`; `settings.depositPercent` (default 25), `settings.depositMinCents` (renamed from `reservation_fee_cents`, default 3000), `settings.cancellationWindowHours` (default 48)

**Steps:**

- [ ] Write the failing test. Replace the ENTIRE contents of `src/test/payments-charge.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { paymentAmounts, chargeForBooking, depositSettingsFromSnapshot } from "@/lib/payments/charge";
import type { QuoteBreakdown } from "@/lib/booking/quote";

const breakdown: QuoteBreakdown = {
  days: 7, vehicleCents: 34800, insuranceCents: 0, addOns: [], addOnsCents: 0, youngDriverCents: 0,
  subtotalCents: 34800, depositCents: 25000, depositPercent: 25, depositMinCents: 3000, currency: "USD",
};

/** Strip the snapshot fields to simulate a pre-wave breakdown. */
function legacyBreakdown(reservationFeeCents: number): QuoteBreakdown {
  const legacy = { ...breakdown, reservationFeeCents } as QuoteBreakdown & { reservationFeeCents: number };
  delete (legacy as { depositPercent?: number }).depositPercent;
  delete (legacy as { depositMinCents?: number }).depositMinCents;
  return legacy;
}

describe("paymentAmounts", () => {
  it("deposit = percent of subtotal when above the floor", () => {
    expect(paymentAmounts(breakdown, "deposit", { depositPercent: 25, depositMinCents: 3000 }))
      .toEqual({ payNowCents: 8700, balanceDueCents: 26100 });
  });
  it("deposit floors at depositMinCents", () => {
    expect(paymentAmounts({ ...breakdown, subtotalCents: 4000 }, "deposit", { depositPercent: 25, depositMinCents: 3000 }))
      .toEqual({ payNowCents: 3000, balanceDueCents: 1000 });
  });
  it("deposit is capped at the subtotal", () => {
    expect(paymentAmounts({ ...breakdown, subtotalCents: 2000 }, "deposit", { depositPercent: 25, depositMinCents: 3000 }))
      .toEqual({ payNowCents: 2000, balanceDueCents: 0 });
  });
  it("full pays the whole subtotal with nothing due at pickup", () => {
    expect(paymentAmounts(breakdown, "full", { depositPercent: 25, depositMinCents: 3000 }))
      .toEqual({ payNowCents: 34800, balanceDueCents: 0 });
  });
});

describe("depositSettingsFromSnapshot", () => {
  it("prefers the snapshotted percent and floor", () => {
    expect(depositSettingsFromSnapshot(breakdown)).toEqual({ depositPercent: 25, depositMinCents: 3000 });
  });
  it("falls back to the legacy reservation fee as a flat deposit", () => {
    expect(depositSettingsFromSnapshot(legacyBreakdown(3000))).toEqual({ depositPercent: 0, depositMinCents: 3000 });
  });
});

describe("chargeForBooking", () => {
  it("deposit option charges the deposit as rental_deposit", () => {
    expect(chargeForBooking("deposit", breakdown)).toEqual({ type: "rental_deposit", amountCents: 8700, currency: "USD" });
  });
  it("full option charges the subtotal as rental_full", () => {
    expect(chargeForBooking("full", breakdown)).toEqual({ type: "rental_full", amountCents: 34800, currency: "USD" });
  });
  it("legacy snapshot charges the old flat reservation fee", () => {
    expect(chargeForBooking("deposit", legacyBreakdown(3000))).toEqual({ type: "rental_deposit", amountCents: 3000, currency: "USD" });
  });
  it("rejects a non-positive charge", () => {
    expect(() => chargeForBooking("deposit", { ...breakdown, subtotalCents: 0, depositPercent: 0, depositMinCents: 0 }))
      .toThrow(/positive/i);
  });
});
```

- [ ] Run it to verify it fails: `npm test -- --no-file-parallelism src/test/payments-charge.test.ts` - expected failure: `paymentAmounts` is not exported (TS compile error / "does not provide an export named").

- [ ] Update `src/lib/db/schema/payments.ts` - replace the two enum lines and the table columns so the file's enum + table section reads exactly (keep the existing `stripeWebhookEvents` table and all existing comments below it unchanged):

```ts
import { pgTable, pgEnum, text, integer, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bookings } from "./bookings";

// reservation_fee + deposit exist only on historical (pre-wave) rows.
// New charges are rental_deposit (partial, holds the car), rental_full
// (whole rental paid online), or extension (delta for added days).
export const paymentType = pgEnum("payment_type", ["reservation_fee", "deposit", "rental_deposit", "rental_full", "extension"]);
export const paymentStatus = pgEnum("payment_status", ["pending", "succeeded", "failed", "refunded"]);
export const paymentMethod = pgEnum("payment_method", ["stripe", "desk"]);

/** One row per charge. Amounts are snapshots computed server-side; Stripe rows
 *  flip status on the SIGNED webhook only; desk rows are settled on insert. */
export const payments = pgTable("payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookingId: uuid("booking_id").notNull().references(() => bookings.id),
  stripeCheckoutSessionId: text("stripe_checkout_session_id").unique(),
  stripePaymentIntentId: text("stripe_payment_intent_id").unique(),
  type: paymentType("type").notNull(),
  method: paymentMethod("method").notNull().default("stripe"),
  amountCents: integer("amount_cents").notNull(),
  refundedCents: integer("refunded_cents").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  status: paymentStatus("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // At most ONE PENDING payment per booking (unchanged rationale, see git history).
  uniqueIndex("payments_one_pending_per_booking").on(t.bookingId).where(sql`${t.status} = 'pending'`),
]);
```

- [ ] Update `src/lib/db/schema/bookings.ts`:
  - Replace `export const paymentOption = pgEnum("payment_option", ["reservation_fee", "full_deposit", "cash_deposit"]);` with `export const paymentOption = pgEnum("payment_option", ["deposit", "full"]);`
  - Directly below the `paymentOption: paymentOption("payment_option").notNull(),` column line, add:

```ts
  // Sum of settled money on this booking. Credited by the Stripe webhook and by
  // desk payments, debited by refunds, so balance-due is queryable.
  amountPaidCents: integer("amount_paid_cents").notNull().default(0),
```

- [ ] Update `src/lib/db/schema/settings.ts` - replace the line `reservationFeeCents: integer("reservation_fee_cents").notNull().default(3000),` with:

```ts
  // Deposit-to-reserve = max(depositPercent% of the rental total, depositMinCents), capped at the total.
  depositPercent: integer("deposit_percent").notNull().default(25),
  depositMinCents: integer("deposit_min_cents").notNull().default(3000),
  // Free cancellation until this many hours before pickup; inside it, no refund.
  cancellationWindowHours: integer("cancellation_window_hours").notNull().default(48),
```

- [ ] Update `SettingsPatchSchema` in `src/lib/admin/settings.ts` - replace `reservationFeeCents: centsField.optional(),` with:

```ts
  depositPercent: z.number().int().min(0).max(100).optional(),
  depositMinCents: centsField.optional(),
  cancellationWindowHours: z.number().int().min(0).max(720).optional(),
```

- [ ] Generate the migration: run `npm run db:generate`. If drizzle-kit asks whether `deposit_min_cents` is a new column or a rename, choose the RENAME from `reservation_fee_cents`. It creates the next-numbered SQL file in `./drizzle` and registers it in `drizzle/meta/_journal.json` (do NOT hardcode a number; other plans also add migrations). Then open the generated SQL file and REPLACE ITS ENTIRE CONTENTS with:

```sql
-- Wave 02 money model: deposit-or-full payment options, amount-paid tracking,
-- desk/extension payment types, refund tracking, deposit settings.
ALTER TABLE "settings" RENAME COLUMN "reservation_fee_cents" TO "deposit_min_cents";--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "deposit_percent" integer DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "cancellation_window_hours" integer DEFAULT 48 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "amount_paid_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "bookings" b SET "amount_paid_cents" = COALESCE((SELECT SUM(p."amount_cents") FROM "payments" p WHERE p."booking_id" = b."id" AND p."status" = 'succeeded'), 0);--> statement-breakpoint
CREATE TYPE "public"."payment_option_v2" AS ENUM('deposit', 'full');--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "payment_option" TYPE "public"."payment_option_v2" USING (CASE "payment_option"::text WHEN 'reservation_fee' THEN 'deposit' WHEN 'full_deposit' THEN 'deposit' WHEN 'cash_deposit' THEN 'deposit' ELSE 'deposit' END)::"public"."payment_option_v2";--> statement-breakpoint
DROP TYPE "public"."payment_option";--> statement-breakpoint
ALTER TYPE "public"."payment_option_v2" RENAME TO "payment_option";--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('stripe', 'desk');--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "method" "payment_method" DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refunded_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TYPE "public"."payment_type" ADD VALUE 'rental_deposit';--> statement-breakpoint
ALTER TYPE "public"."payment_type" ADD VALUE 'rental_full';--> statement-breakpoint
ALTER TYPE "public"."payment_type" ADD VALUE 'extension';
```

  Notes: every historical `payment_option` value maps to `deposit` (they all meant "partial paid online"). `ALTER TYPE ... ADD VALUE` inside a migration transaction is fine on PG12+/PGlite because the new values are not used in the same transaction. The `UPDATE` backfills `amount_paid_cents` from succeeded payments.

- [ ] Update `src/lib/booking/quote.ts` (targeted edits only; do NOT touch `rentalDays` or `bestVehicleCents`, plan 01 owns those):
  - In `QuoteInput`, replace `reservationFeeCents: number;` with:

```ts
  depositPercent: number;
  depositMinCents: number;
```

  - In `QuoteBreakdown`, replace the two lines

```ts
  /** Upfront amount that locks the booking. */
  reservationFeeCents: number;
```

  with:

```ts
  /** Young-driver surcharge line. Always 0 until the young-driver workstream wires it. */
  youngDriverCents: number;
  /** Deposit settings snapshotted at quote time; they drive the pay-now math forever after. */
  depositPercent: number;
  depositMinCents: number;
```

  - In `quote()`, change the destructure `const { days, vehicle, insurance, addOns, reservationFeeCents, currency } = input;` to `const { days, vehicle, insurance, addOns, depositPercent, depositMinCents, currency } = input;`
  - In the return object, replace `subtotalCents: vehicleCents + insuranceCents + addOnsCents,` with:

```ts
    youngDriverCents: 0,
    subtotalCents: vehicleCents + insuranceCents + addOnsCents,
```

  and replace `reservationFeeCents,` with:

```ts
    depositPercent,
    depositMinCents,
```

- [ ] Replace the ENTIRE contents of `src/lib/payments/charge.ts` with:

```ts
/**
 * What to charge for a booking, derived ONLY from its server-computed snapshot.
 * Never trust a client amount.
 *
 * The customer chooses ONE of two options:
 *   deposit -> pay max(depositPercent% of the rental total, depositMinCents) now
 *              (capped at the total), balance due at pickup
 *   full    -> pay the whole rental total now, nothing due at pickup
 *
 * The vehicle security deposit (borg, breakdown.depositCents) is NEVER charged
 * online; it is an at-pickup information line only.
 */
import type { QuoteBreakdown } from "@/lib/booking/quote";

export type PaymentOption = "deposit" | "full";

/** payments.type values. reservation_fee + deposit exist only on historical rows. */
export type ChargeType = "reservation_fee" | "deposit" | "rental_deposit" | "rental_full" | "extension";

export interface Charge {
  type: ChargeType;
  amountCents: number;
  currency: string;
}

export interface DepositSettings {
  depositPercent: number;
  depositMinCents: number;
}

export interface PaymentAmounts {
  payNowCents: number;
  balanceDueCents: number;
}

/** Deposit settings for amount math. Prefer the values snapshotted onto the
 *  breakdown at quote time; a pre-wave snapshot (no depositPercent) falls back
 *  to its old reservationFeeCents as a flat deposit (percent 0), so a legacy
 *  pending booking still charges exactly what its open session was created for. */
export function depositSettingsFromSnapshot(breakdown: QuoteBreakdown): DepositSettings {
  if (typeof breakdown.depositPercent === "number" && typeof breakdown.depositMinCents === "number") {
    return { depositPercent: breakdown.depositPercent, depositMinCents: breakdown.depositMinCents };
  }
  const legacy = breakdown as QuoteBreakdown & { reservationFeeCents?: number };
  return { depositPercent: 0, depositMinCents: legacy.reservationFeeCents ?? 0 };
}

/** Amount due now + balance at pickup for a chosen option. */
export function paymentAmounts(breakdown: QuoteBreakdown, option: PaymentOption, settings: DepositSettings): PaymentAmounts {
  const subtotal = breakdown.subtotalCents;
  if (option === "full") return { payNowCents: subtotal, balanceDueCents: 0 };
  const raw = Math.round((subtotal * settings.depositPercent) / 100);
  const payNow = Math.min(Math.max(raw, settings.depositMinCents), subtotal);
  return { payNowCents: payNow, balanceDueCents: subtotal - payNow };
}

export function chargeForBooking(paymentOption: PaymentOption, breakdown: QuoteBreakdown): Charge {
  const amounts = paymentAmounts(breakdown, paymentOption, depositSettingsFromSnapshot(breakdown));
  if (amounts.payNowCents <= 0) throw new Error("charge amount must be positive");
  return {
    type: paymentOption === "full" ? "rental_full" : "rental_deposit",
    amountCents: amounts.payNowCents,
    currency: breakdown.currency,
  };
}
```

- [ ] Run the charge test again to verify it passes: `npm test -- --no-file-parallelism src/test/payments-charge.test.ts` - expected: all tests green (the rest of the repo does not compile yet in `tsc`, but this vitest file only pulls charge.ts + quote.ts).

- [ ] Update `src/lib/booking/create.ts`:
  - In `BookingCreateSchema`, replace `paymentOption: z.enum(["reservation_fee", "full_deposit", "cash_deposit"]),` with `paymentOption: z.enum(["deposit", "full"]),`
  - DELETE this whole guard block (both `if` statements and the comment; it sits between the `checkAvailability` conflict throw and the insurance-tier resolution):

```ts
  if (input.paymentOption === "full_deposit" && vehicle.depositCents === null) {
    throw Errors.badRequest("Paying the full deposit online is not available for this car yet");
  }
  // A reservation_fee / cash_deposit booking is locked by charging the online
  // reservation fee. If the owner set that fee to 0 the booking would be created
  // but never chargeable (chargeForBooking throws), so reject it up front rather
  // than leave an unpayable hold tying up the car until it expires.
  if (
    (input.paymentOption === "reservation_fee" || input.paymentOption === "cash_deposit") &&
    settings.reservationFeeCents <= 0
  ) {
    throw Errors.badRequest("Online reservation is unavailable right now; please contact us to book");
  }
```

  - In the `quote({ ... })` call, replace `reservationFeeCents: settings.reservationFeeCents,` with:

```ts
    depositPercent: settings.depositPercent,
    depositMinCents: settings.depositMinCents,
```

  - Directly AFTER the `const breakdown = quote({ ... });` statement, add (and add `import { paymentAmounts } from "@/lib/payments/charge";` to the imports):

```ts
  // If the owner zeroed both deposit knobs the booking could never be charged
  // (chargeForBooking throws), so reject up front instead of stranding a hold.
  const amounts = paymentAmounts(breakdown, input.paymentOption, {
    depositPercent: settings.depositPercent,
    depositMinCents: settings.depositMinCents,
  });
  if (amounts.payNowCents <= 0) {
    throw Errors.badRequest("Online reservation is unavailable right now; please contact us to book");
  }
```

- [ ] Update `src/lib/booking/public.ts` - in the `quote({ ... })` call inside `publicQuote`, replace `reservationFeeCents: settings.reservationFeeCents,` with:

```ts
    depositPercent: settings.depositPercent,
    depositMinCents: settings.depositMinCents,
```

- [ ] Update `src/lib/admin/move-booking.ts` - in its `quote({ ... })` call, make the same replacement: `reservationFeeCents: settings.reservationFeeCents,` becomes `depositPercent: settings.depositPercent,` + `depositMinCents: settings.depositMinCents,`

- [ ] Update `src/lib/admin/manual-booking.ts` - replace `paymentOption: "cash_deposit",` with `paymentOption: "full",` (manual desk bookings settle at the desk; `full` makes balance-due math read as price minus paid).

- [ ] Update `src/lib/payments/checkout.ts`:
  - Replace the `LABEL` map with:

```ts
const LABEL: Record<ChargeType, string> = {
  reservation_fee: "Reservation fee",
  deposit: "Security deposit",
  rental_deposit: "Deposit to reserve",
  rental_full: "Rental payment",
  extension: "Extension payment",
};
```

  and change the charge import line to `import { chargeForBooking, type PaymentOption, type ChargeType } from "@/lib/payments/charge";`
  - In the payments insert inside the transaction (the `await tx.insert(payments).values({ ... })` that records the pending row), add `method: "stripe",` after `type: charge.type,`
  - Replace the `cancel_url` line `cancel_url: \`${origin}/book?canceled=1\`,` with:

```ts
      cancel_url: `${origin}/book?canceled=1&id=${booking.id}`,
```

- [ ] Update `src/lib/email/templates.ts` - in `bookingConfirmedEmail`, change the args type member `chargeType?: "reservation_fee" | "deposit";` to `chargeType?: string;` and replace the `paidLine` computation with:

```ts
  const CHARGE_LABEL: Record<string, string> = {
    reservation_fee: "(reservation fee)",
    deposit: "(refundable deposit)",
    rental_deposit: "(deposit, balance due at pickup)",
    rental_full: "(paid in full)",
    extension: "(extension payment)",
  };
  const paidLine = args.amountPaidCents !== undefined
    ? `Paid now: <strong>${money(args.amountPaidCents, args.currency)}</strong> ${CHARGE_LABEL[args.chargeType ?? ""] ?? ""}<br>`
    : "";
```

- [ ] Minimal wizard compile fix in `src/app/(public)/book/page.tsx` (the real step 7 rebuild is Task 11; this only keeps the repo compiling):
  - In the `Breakdown` interface, replace `reservationFeeCents: number;` with `depositPercent: number; depositMinCents: number; youngDriverCents: number;`
  - Replace the state line `const [paymentOption, setPaymentOption] = useState<"reservation_fee" | "full_deposit" | "cash_deposit">("reservation_fee");` with `const [paymentOption, setPaymentOption] = useState<"deposit" | "full">("deposit");`
  - Replace the whole `{breakdown && (<div className="pay-options"> ... </div>)}` block (the three radio labels) with:

```tsx
                {breakdown && (
                  <div className="pay-options">
                    <label className="opt"><input type="radio" name="pay" checked={paymentOption === "deposit"} onChange={() => setPaymentOption("deposit")} /><span className="grow">Reserve with a deposit, pay the rest at pickup</span></label>
                    <label className="opt"><input type="radio" name="pay" checked={paymentOption === "full"} onChange={() => setPaymentOption("full")} /><span className="grow">Pay the full rental now</span></label>
                  </div>
                )}
```

  - Replace the closing note `<p className="note">You&apos;ll be taken to our secure Stripe checkout to pay the {paymentOption === "full_deposit" ? "deposit" : "reservation fee"}.</p>` with `<p className="note">You&apos;ll be taken to our secure Stripe checkout.</p>`

- [ ] Mechanical test sweep, part 1 (the `paymentOption` fixture literal). Run exactly:

```bash
grep -rl 'paymentOption: "reservation_fee"' src/test | xargs sed -i '' 's/paymentOption: "reservation_fee"/paymentOption: "deposit"/g'
```

  This updates: `audit-fixes.test.ts`, `payments-checkout-guard.test.ts`, `payments-webhook.test.ts`, `booking-create.test.ts`, `booking-availability.test.ts`, `ops-schema.test.ts`, `customer-bookings.test.ts`, `payments-holds.test.ts`, `admin-planning.test.ts`, `booking-overlap.test.ts` (the `as const` suffix there survives), `bugfixes.test.ts`, `email-templates.test.ts` (if present in that form).

- [ ] Mechanical test sweep, part 2 (hand edits):
  - `src/test/move-booking.test.ts`: `paymentOption: "cash_deposit",` becomes `paymentOption: "full",`
  - `src/test/manual-booking.test.ts`: `expect(b.paymentOption).toBe("cash_deposit");` becomes `expect(b.paymentOption).toBe("full");`
  - `src/test/email-templates.test.ts`: both occurrences of `chargeType: "reservation_fee"` become `chargeType: "rental_deposit"`; the `adminNewBookingEmail({ ... paymentOption: "reservation_fee" })` arg becomes `paymentOption: "deposit"` (if the sed in part 1 did not already catch it).
  - `src/test/payments-checkout-guard.test.ts` and `src/test/payments-webhook.test.ts`: in each file's `const breakdown = { ... }` fixture, replace `reservationFeeCents: 3000,` with `youngDriverCents: 0, depositPercent: 0, depositMinCents: 3000,` (percent 0 keeps the expected charge at the flat 3000 the fixtures' payment rows and events already use).
  - `src/test/booking-quote.test.ts`: in both `quote({ ... })` calls replace `reservationFeeCents: 3000,` with `depositPercent: 25, depositMinCents: 3000,`; replace the assertion `expect(b.reservationFeeCents).toBe(3000);` with:

```ts
    expect(b.depositPercent).toBe(25);
    expect(b.depositMinCents).toBe(3000);
    expect(b.youngDriverCents).toBe(0);
```

  - `src/test/admin-settings.test.ts`: replace the two `patchSettings`/assert lines in "applies a partial update" with:

```ts
    const updated = await patchSettings({ depositMinCents: 3500, minDriverAge: 23 });
    expect(updated.depositMinCents).toBe(3500);
```

  and replace `expect(SettingsPatchSchema.safeParse({ reservationFeeCents: -5 }).success).toBe(false);` with:

```ts
    expect(SettingsPatchSchema.safeParse({ depositMinCents: -5 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ depositPercent: 130 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ cancellationWindowHours: -1 }).success).toBe(false);
```

  - `src/test/booking-create.test.ts`: replace the whole test `it("rejects full_deposit when the car has no deposit set", async () => { ... });` with (add `import { eq } from "drizzle-orm";`, `import { getDb } from "@/lib/db/client";`, `import { settings } from "@/lib/db/schema";` to the file's imports if not already present):

```ts
  it("rejects booking when settings make the pay-now amount zero", async () => {
    const db = await getDb();
    await db.update(settings).set({ depositPercent: 0, depositMinCents: 0 }).where(eq(settings.id, 1));
    await expect(
      createBooking(input({ paymentOption: "deposit", idempotencyKey: "dep-1" }), TODAY),
    ).rejects.toThrow(/unavailable/i);
    await db.update(settings).set({ depositPercent: 25, depositMinCents: 3000 }).where(eq(settings.id, 1));
  });
```

  (Keep the helper names the file actually uses; `input(...)` and `TODAY` exist today. If the surrounding test uses different date fixtures after plan 01, keep them.)

- [ ] Typecheck: `npx tsc --noEmit` - expected: clean.
- [ ] Full suite: `npm test -- --no-file-parallelism` - expected: all green.
- [ ] Lint: `npm run lint` - expected: clean.
- [ ] Commit:

```bash
git add -A
git commit -m "feat(payments): deposit-or-full money model, amount-paid tracking, desk/extension payment types"
```

---

### Task 2: Webhook: amount tracking, row-first verification, extension payments, refund reconciliation

**Files:**
- Modify: `src/lib/payments/webhook.ts` (full replacement below; neither plan 01 nor Task 1 touched it)
- Test: `src/test/payments-webhook.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `chargeForBooking`, `type PaymentOption` from `src/lib/payments/charge.ts` (Task 1); `bookings.amountPaidCents`, `payments.method/refundedCents` columns (Task 1); `notifyAdmin` from `@/lib/notify`.
- Produces: `processStripeEvent(event: Stripe.Event): Promise<ProcessResult>` (same signature as before; `ProcessResult = { handled: boolean; duplicate?: boolean; bookingConfirmed?: boolean; bookingId?: string }`). New behavior later tasks rely on: extension checkout sessions (metadata `paymentType: "extension"`) mark their payment row succeeded and credit `amountPaidCents` WITHOUT touching booking status; `charge.refunded` events reconcile `refundedCents`/status idempotently.

**Steps:**

- [ ] Write the failing tests. Append to the END of `src/test/payments-webhook.test.ts` (inside the file, after the existing describe):

```ts
describe("wave 02 payment tracking", () => {
  it("credits amountPaidCents when a booking is confirmed", async () => {
    const b = await makePendingBooking("wh-amt-1", "cs_amt_1");
    await processStripeEvent(paidEvent("evt_amt_1", "cs_amt_1", b.id));
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe("confirmed");
    expect(after!.amountPaidCents).toBe(3000);
  });

  it("verifies against the recorded payment row, not recomputed snapshot math", async () => {
    const b = await makePendingBooking("wh-row-1", "cs_row_1");
    // Poison the snapshot so a recompute would demand a different amount; the
    // recorded pending row (3000) must win.
    await db.update(bookings)
      .set({ priceBreakdown: { ...breakdown, subtotalCents: 999999, depositPercent: 50, depositMinCents: 50000 } })
      .where(eq(bookings.id, b.id));
    const res = await processStripeEvent(paidEvent("evt_row_1", "cs_row_1", b.id));
    expect(res.bookingConfirmed).toBe(true);
  });

  it("extension payment confirms the payment and credits the booking without touching status", async () => {
    const b = await makePendingBooking("wh-ext-1", "cs_ext_seed_1");
    await processStripeEvent(paidEvent("evt_ext_seed_1", "cs_ext_seed_1", b.id)); // now confirmed, paid 3000
    await db.insert(payments).values({
      bookingId: b.id, stripeCheckoutSessionId: "cs_ext_1", type: "extension", method: "stripe",
      amountCents: 5800, currency: "USD", status: "pending",
    });
    const res = await processStripeEvent(paidEvent("evt_ext_1", "cs_ext_1", b.id, {
      amount_total: 5800, metadata: { bookingId: b.id, paymentType: "extension" },
    }));
    expect(res.bookingConfirmed).toBe(false);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.status).toBe("confirmed");
    expect(after!.amountPaidCents).toBe(3000 + 5800);
    const [pay] = await db.select().from(payments).where(eq(payments.stripeCheckoutSessionId, "cs_ext_1"));
    expect(pay!.status).toBe("succeeded");
  });

  it("charge.refunded reconciles refund totals and decrements amountPaidCents", async () => {
    const b = await makePendingBooking("wh-ref-1", "cs_ref_1");
    await processStripeEvent(paidEvent("evt_ref_seed_1", "cs_ref_1", b.id)); // paid 3000, pi_cs_ref_1
    const refundEvent = {
      id: "evt_ref_1", type: "charge.refunded", object: "event", api_version: null,
      created: 0, livemode: false, pending_webhooks: 0, request: null,
      data: { object: { id: "ch_ref_1", object: "charge", payment_intent: "pi_cs_ref_1", amount_refunded: 3000 } },
    } as unknown as Stripe.Event;
    await processStripeEvent(refundEvent);
    const [pay] = await db.select().from(payments).where(eq(payments.stripeCheckoutSessionId, "cs_ref_1"));
    expect(pay!.status).toBe("refunded");
    expect(pay!.refundedCents).toBe(3000);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after!.amountPaidCents).toBe(0);
    // Redelivery of the same totals is a no-op (delta 0).
    const again = { ...refundEvent, id: "evt_ref_2" } as unknown as Stripe.Event;
    await processStripeEvent(again);
    const [after2] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(after2!.amountPaidCents).toBe(0);
  });
});
```

- [ ] Run to verify the new block fails: `npm test -- --no-file-parallelism src/test/payments-webhook.test.ts` - expected failures: `amountPaidCents` stays 0, extension event is treated as a surplus, `charge.refunded` is ignored.

- [ ] Replace the ENTIRE contents of `src/lib/payments/webhook.ts` with:

```ts
/**
 * Inbound Stripe webhook reducer (signature already verified by the route via
 * stripe.webhooks.constructEvent).
 *
 * Money-safety properties:
 *   - ATOMIC: the event-id dedupe claim and every write commit in ONE
 *     transaction; a failure rolls the claim back so Stripe's retry redoes the
 *     work for real.
 *   - AUTHORITATIVE payment record: the payment row is UPSERTED by session id.
 *   - Amount/currency verified BEFORE any confirmation. The recorded payment
 *     row for the session is the primary expectation (it was written when the
 *     session was created, so it survives settings changes and legacy
 *     snapshots); recomputing from the snapshot is the fallback for a lost
 *     checkout-time insert.
 *   - Confirms ONLY a still-pending booking; surplus captures are recorded,
 *     flagged, and auto-refunded.
 *   - bookings.amount_paid_cents is credited on confirmation and on extension
 *     payments, and debited by charge.refunded reconciliation.
 *   - Extension payments (metadata paymentType=extension) confirm the PAYMENT
 *     only; the booking dates were already extended when the link was created.
 */
import type Stripe from "stripe";
import { eq, and, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, payments, stripeWebhookEvents } from "@/lib/db/schema";
import { chargeForBooking, type PaymentOption } from "@/lib/payments/charge";
import type { QuoteBreakdown } from "@/lib/booking/quote";
import { getStripe } from "@/lib/payments/stripe-client";
import { notifyAdmin } from "@/lib/notify";
import { logger } from "@/lib/logger";

export interface ProcessResult {
  handled: boolean;
  duplicate?: boolean;
  bookingConfirmed?: boolean;
  bookingId?: string;
}

const CONFIRM_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);

export async function processStripeEvent(event: Stripe.Event): Promise<ProcessResult> {
  // async_payment_failed AND expired both mean "this session will never pay".
  if (event.type === "checkout.session.async_payment_failed" || event.type === "checkout.session.expired") {
    return markSessionFailed(event);
  }
  if (event.type === "charge.refunded") {
    return reconcileRefund(event);
  }
  if (!CONFIRM_EVENTS.has(event.type)) {
    return { handled: true }; // acked + ignored (no side effect, safe to reprocess)
  }

  const session = event.data.object as Stripe.Checkout.Session;
  if (event.type === "checkout.session.completed" && session.payment_status !== "paid") {
    return { handled: true };
  }

  const bookingId = session.metadata?.bookingId;
  if (!bookingId) {
    logger.warn("stripe_webhook_no_booking", { sessionId: session.id, eventId: event.id });
    return { handled: true };
  }

  const paymentIntentId = typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id ?? null;

  const db = await getDb();
  let result: ProcessResult = { handled: true };
  let surplusRefund: { paymentIntentId: string; sessionId: string } | null = null;
  let extensionPaid = false;

  await db.transaction(async (tx) => {
    const claimed = await tx.insert(stripeWebhookEvents)
      .values({ eventId: event.id, type: event.type })
      .onConflictDoNothing({ target: stripeWebhookEvents.eventId })
      .returning({ eventId: stripeWebhookEvents.eventId });
    if (claimed.length === 0) { result = { handled: true, duplicate: true }; return; }

    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, bookingId));
    if (!booking) {
      logger.warn("stripe_webhook_booking_missing", { bookingId, eventId: event.id });
      return; // claim commits; nothing to confirm
    }

    // Row-first amount verification (see module doc).
    const [known] = await tx.select().from(payments).where(eq(payments.stripeCheckoutSessionId, session.id));
    const expected = known
      ? { type: known.type, amountCents: known.amountCents, currency: known.currency }
      : chargeForBooking(booking.paymentOption as PaymentOption, booking.priceBreakdown as QuoteBreakdown);

    const paidAmount = session.amount_total ?? 0;
    const paidCurrency = (session.currency ?? "").toUpperCase();
    if (paidAmount !== expected.amountCents || paidCurrency !== expected.currency.toUpperCase()) {
      logger.error("stripe_webhook_amount_mismatch", { bookingId, paidAmount, expected: expected.amountCents, paidCurrency, eventId: event.id });
      return; // do NOT confirm on a mismatch
    }

    if (session.metadata?.paymentType === "extension" || known?.type === "extension") {
      await tx.insert(payments).values({
        bookingId: booking.id, stripeCheckoutSessionId: session.id, stripePaymentIntentId: paymentIntentId,
        type: "extension", method: "stripe", amountCents: expected.amountCents, currency: expected.currency, status: "succeeded",
      }).onConflictDoUpdate({
        target: payments.stripeCheckoutSessionId,
        set: { status: "succeeded", stripePaymentIntentId: paymentIntentId, updatedAt: new Date() },
      });
      await tx.update(bookings)
        .set({ amountPaidCents: sql`${bookings.amountPaidCents} + ${expected.amountCents}`, updatedAt: new Date() })
        .where(eq(bookings.id, booking.id));
      extensionPaid = true;
      result = { handled: true, bookingConfirmed: false, bookingId: booking.id };
      return;
    }

    // Upsert the payment row by session id -> succeeded (authoritative record).
    await tx.insert(payments).values({
      bookingId: booking.id,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: paymentIntentId,
      type: expected.type,
      method: "stripe",
      amountCents: expected.amountCents,
      currency: expected.currency,
      status: "succeeded",
    }).onConflictDoUpdate({
      target: payments.stripeCheckoutSessionId,
      set: { status: "succeeded", stripePaymentIntentId: paymentIntentId, updatedAt: new Date() },
    });

    // Flip pending -> confirmed (guarded) and credit the paid amount.
    const flipped = await tx.update(bookings)
      .set({
        status: "confirmed",
        amountPaidCents: sql`${bookings.amountPaidCents} + ${expected.amountCents}`,
        updatedAt: new Date(),
      })
      .where(and(eq(bookings.id, booking.id), eq(bookings.status, "pending")))
      .returning({ id: bookings.id });

    if (flipped.length > 0) {
      result = { handled: true, bookingConfirmed: true, bookingId: booking.id };
    } else {
      // Money captured but the booking was not pending: a real surplus charge.
      // Never resurrect a cancelled booking; flag + queue an automatic refund
      // once the transaction commits. Surplus money is NOT credited to
      // amount_paid_cents (it is on its way back to the card).
      logger.error("stripe_webhook_surplus_payment_needs_refund", {
        bookingId: booking.id, bookingStatus: booking.status, paymentIntentId, sessionId: session.id, eventId: event.id,
      });
      if (paymentIntentId) surplusRefund = { paymentIntentId, sessionId: session.id };
      result = { handled: true, bookingConfirmed: false };
    }
  });

  if (extensionPaid) {
    await notifyAdmin({
      level: "success", type: "payment.received", title: "Extension payment received",
      body: "The customer paid the extension link.", bookingId,
    });
  }

  if (surplusRefund) {
    const { paymentIntentId: pi, sessionId } = surplusRefund;
    try {
      await getStripe().refunds.create({ payment_intent: pi });
      logger.warn("stripe_webhook_surplus_refunded", { paymentIntentId: pi, sessionId, eventId: event.id });
    } catch (e) {
      logger.error("stripe_webhook_surplus_refund_failed", { paymentIntentId: pi, sessionId, eventId: event.id, error: String(e) });
    }
  }

  return result;
}

async function markSessionFailed(event: Stripe.Event): Promise<ProcessResult> {
  const session = event.data.object as Stripe.Checkout.Session;
  const db = await getDb();
  await db.transaction(async (tx) => {
    const claimed = await tx.insert(stripeWebhookEvents)
      .values({ eventId: event.id, type: event.type })
      .onConflictDoNothing({ target: stripeWebhookEvents.eventId })
      .returning({ eventId: stripeWebhookEvents.eventId });
    if (claimed.length === 0) return;
    await tx.update(payments)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(payments.stripeCheckoutSessionId, session.id));
  });
  return { handled: true };
}

/** charge.refunded: reconcile refund totals idempotently. refundPayment()
 *  records refunds it makes itself, so the delta here is usually 0; a refund
 *  made in the Stripe dashboard is picked up by this path. */
async function reconcileRefund(event: Stripe.Event): Promise<ProcessResult> {
  const charge = event.data.object as Stripe.Charge;
  const paymentIntentId = typeof charge.payment_intent === "string"
    ? charge.payment_intent
    : charge.payment_intent?.id ?? null;
  if (!paymentIntentId) return { handled: true };
  const db = await getDb();
  await db.transaction(async (tx) => {
    const claimed = await tx.insert(stripeWebhookEvents)
      .values({ eventId: event.id, type: event.type })
      .onConflictDoNothing({ target: stripeWebhookEvents.eventId })
      .returning({ eventId: stripeWebhookEvents.eventId });
    if (claimed.length === 0) return;
    const [payment] = await tx.select().from(payments).where(eq(payments.stripePaymentIntentId, paymentIntentId));
    if (!payment) return;
    const refundedTotal = charge.amount_refunded ?? 0;
    const delta = refundedTotal - payment.refundedCents;
    if (delta <= 0) return; // already recorded (e.g. by refundPayment)
    await tx.update(payments).set({
      refundedCents: refundedTotal,
      status: refundedTotal >= payment.amountCents ? "refunded" : payment.status,
      updatedAt: new Date(),
    }).where(eq(payments.id, payment.id));
    await tx.update(bookings)
      .set({ amountPaidCents: sql`GREATEST(0, ${bookings.amountPaidCents} - ${delta})`, updatedAt: new Date() })
      .where(eq(bookings.id, payment.bookingId));
  });
  return { handled: true };
}
```

- [ ] Run the webhook tests: `npm test -- --no-file-parallelism src/test/payments-webhook.test.ts` - expected: all green, including the pre-existing surplus/idempotency tests.
- [ ] Full suite + typecheck: `npm test -- --no-file-parallelism` and `npx tsc --noEmit` - expected: green/clean.
- [ ] Commit:

```bash
git add -A
git commit -m "feat(payments): webhook credits amount paid, verifies against the recorded row, handles extension payments and charge.refunded"
```

---

### Task 3: Settings surface for the new money knobs

**Files:**
- Modify: `src/app/admin/(shell)/settings/page.tsx`
- Test: none new (schema validation was covered in Task 1's `admin-settings.test.ts` updates); this is a UI task

**Interfaces:**
- Consumes: `PATCH /api/admin/settings` already accepts `depositPercent`, `depositMinCents`, `cancellationWindowHours` (Task 1 updated `SettingsPatchSchema`); `GET /api/admin/settings` returns them.
- Produces: nothing consumed by later tasks; the owner can now edit the three knobs.

**Steps:**

- [ ] In `src/app/admin/(shell)/settings/page.tsx`:
  - In the `interface Settings`, replace `reservationFeeCents: number;` with `depositPercent: number; depositMinCents: number; cancellationWindowHours: number;` (plan 01 already renamed the turnaround field; leave it as found).
  - In the `save()` payload, replace `reservationFeeCents: s.reservationFeeCents,` with:

```ts
        depositPercent: s.depositPercent,
        depositMinCents: s.depositMinCents,
        cancellationWindowHours: s.cancellationWindowHours,
```

  - In the form grid, replace the whole "Reservation fee" label block

```tsx
              <label>Reservation fee ({s.currency})
                <input type="number" step="0.01" min="0" value={dollars(s.reservationFeeCents)}
                  onChange={(e) => setS({ ...s, reservationFeeCents: Math.round(Number(e.target.value) * 100) })} />
              </label>
```

  with:

```tsx
              <label>Deposit percent of the rental total
                <input type="number" min="0" max="100" value={s.depositPercent}
                  onChange={(e) => setS({ ...s, depositPercent: Number(e.target.value) })} />
              </label>
              <label>Deposit minimum ({s.currency})
                <input type="number" step="0.01" min="0" value={dollars(s.depositMinCents)}
                  onChange={(e) => setS({ ...s, depositMinCents: Math.round(Number(e.target.value) * 100) })} />
              </label>
              <label>Free cancellation window (hours before pickup)
                <input type="number" min="0" max="720" value={s.cancellationWindowHours}
                  onChange={(e) => setS({ ...s, cancellationWindowHours: Number(e.target.value) })} />
              </label>
```

- [ ] Typecheck + lint: `npx tsc --noEmit` and `npm run lint` - expected: clean.
- [ ] Manual verification: `npm run dev`, sign in at `http://localhost:3000/admin`, open Settings. Confirm the three new fields render with values 25 / 30.00 / 48, change the deposit percent to 30, save, reload, and see 30 persisted. (Stop the dev server afterwards; never run `npm run build` while it runs.)
- [ ] Commit:

```bash
git add -A
git commit -m "feat(admin): settings fields for deposit percent, deposit minimum, cancellation window"
```

---

### Task 4: Site config: brand from env

**Files:**
- Create: `src/lib/site-config.ts`
- Modify: `src/app/(public)/layout.tsx`, `src/lib/email/templates.ts` (shell + login subject), `src/lib/payments/checkout.ts` (product fallback name), `.env.example`
- Test: none new (pure constants); existing email tests must stay green

**Interfaces:**
- Consumes: `process.env.NEXT_PUBLIC_SITE_NAME`, `process.env.NEXT_PUBLIC_SITE_URL`, `process.env.NEXT_PUBLIC_WHATSAPP_NUMBER` (all optional, FleetDesk defaults).
- Produces (seam names, consumed by Tasks 11-12 and by plan 09's Tex port): `siteConfig: { siteName: string; siteUrl: string; backLinkLabel: string; whatsappHref: string | null }` from `src/lib/site-config.ts`.

**Steps:**

- [ ] Create `src/lib/site-config.ts`:

```ts
/**
 * Public brand configuration. Values come from NEXT_PUBLIC_* env vars, which
 * Next.js inlines at build time, so this module is safe in client AND server
 * code. A white-label deploy (the Tex Cars port) becomes an env change instead
 * of string surgery.
 */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://fleetdesk.app";
const whatsappDigits = (process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? "").replace(/[^0-9]/g, "");

export interface SiteConfig {
  siteName: string;
  siteUrl: string;
  backLinkLabel: string;
  whatsappHref: string | null;
}

export const siteConfig: SiteConfig = {
  siteName: process.env.NEXT_PUBLIC_SITE_NAME ?? "FleetDesk",
  siteUrl,
  backLinkLabel: `Back to ${hostOf(siteUrl)}`,
  whatsappHref: whatsappDigits ? `https://wa.me/${whatsappDigits}` : null,
};
```

- [ ] In `src/app/(public)/layout.tsx`, add `import { siteConfig } from "@/lib/site-config";` and:
  - Replace `export const metadata: Metadata = { title: "Book a car | FleetDesk" };` with `export const metadata: Metadata = { title: \`Book a car | ${siteConfig.siteName}\` };`
  - Replace the header anchor block

```tsx
          <a className="pub-brand" href="https://fleetdesk.app" aria-label="FleetDesk home">
            <span className="pub-brand-mark" aria-hidden="true">
              ~&lt;
            </span>
            <span className="pub-brand-word">FleetDesk</span>
          </a>
```

  with:

```tsx
          <a className="pub-brand" href={siteConfig.siteUrl} aria-label={`${siteConfig.siteName} home`}>
            <span className="pub-brand-mark" aria-hidden="true">
              ~&lt;
            </span>
            <span className="pub-brand-word">{siteConfig.siteName}</span>
          </a>
```

- [ ] In `src/lib/email/templates.ts`, add `import { siteConfig } from "@/lib/site-config";` and:
  - Replace the `shell` function's brand div line

```ts
  <div style="font-weight:800;letter-spacing:.03em;font-size:18px;margin-bottom:20px">FLEET<span style="color:#f15f2c">DESK</span></div>
```

  with:

```ts
  <div style="font-weight:800;letter-spacing:.03em;font-size:18px;margin-bottom:20px">${siteConfig.siteName.toUpperCase()}</div>
```

  - Replace the footer line `<p style="color:#828aa6;font-size:12px;margin-top:28px">FleetDesk &amp; Leasing, Aruba. We bring the car to you.</p>` with `<p style="color:#828aa6;font-size:12px;margin-top:28px">${siteConfig.siteName}, Aruba. We bring the car to you.</p>`
  - Replace `subject: "Your FleetDesk sign-in code",` with `subject: \`Your ${siteConfig.siteName} sign-in code\`,`
- [ ] In `src/lib/payments/checkout.ts`, replace the product fallback string `"FleetDesk rental"` with `` `${siteConfig.siteName} rental` `` and add `import { siteConfig } from "@/lib/site-config";`
- [ ] Append to `.env.example` (near the existing `NEXT_PUBLIC_DEMO_MODE` line):

```bash
# Public brand (white-label): shown in the public header, emails, and links.
NEXT_PUBLIC_SITE_NAME=FleetDesk
NEXT_PUBLIC_SITE_URL=https://fleetdesk.app
# Optional: enables the WhatsApp contact link on the confirmation page (digits with country code).
NEXT_PUBLIC_WHATSAPP_NUMBER=
```

- [ ] Run `npm test -- --no-file-parallelism src/test/email-templates.test.ts` - expected: green (the templates still render "FLEETDESK" by default).
- [ ] Typecheck + lint: `npx tsc --noEmit` and `npm run lint` - expected: clean.
- [ ] Commit:

```bash
git add -A
git commit -m "feat(brand): env-driven site config replaces hardcoded fleetdesk.app in public layout, emails, checkout"
```

---

### Task 5: Pure money movers — `amounts.ts` extraction + `isFreeCancellation` + `refundPayment`

**Files:**
- Create: `src/lib/payments/amounts.ts`, `src/lib/booking/cancellation.ts`, `src/lib/payments/refunds.ts`
- Modify: `src/lib/payments/charge.ts` (re-export from amounts.ts), `src/app/api/admin/payments/[id]/refund/route.ts` (create)
- Test: `src/test/cancellation-policy.test.ts`, `src/test/refunds.test.ts`

**Interfaces:**
- Consumes: `paymentAmounts`, `depositSettingsFromSnapshot`, `PaymentOption`, `PaymentAmounts`, `DepositSettings` (Task 1, currently in `src/lib/payments/charge.ts`); `payments.refundedCents`/`method` columns (Task 1); webhook `charge.refunded` reconciliation (Task 2); `parseTs` from `@/lib/time/format`.
- Produces:
  - `src/lib/payments/amounts.ts`: the pure types + `paymentAmounts` + `depositSettingsFromSnapshot` MOVED here verbatim (no server imports, safe for client components; Task 11 imports it in the wizard). `charge.ts` re-exports all of them so every existing import keeps working.
  - `isFreeCancellation(booking: { startAt: string }, settings: { cancellationWindowHours: number }, nowIso: string): boolean` in `src/lib/booking/cancellation.ts`.
  - `refundPayment(paymentId: string, opts: { amountCents?: number }): Promise<{ refundedCents: number; status: string }>` in `src/lib/payments/refunds.ts`; route `POST /api/admin/payments/[id]/refund` body `{ amountCents?: number }`, `mutate` audit action `admin.payment_refunded`.

- [ ] Write the failing tests. Create `src/test/cancellation-policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isFreeCancellation } from "@/lib/booking/cancellation";
import { atAruba } from "@/lib/time/format";

const settings = { cancellationWindowHours: 48 };

describe("isFreeCancellation", () => {
  it("is free strictly before the window opens", () => {
    expect(isFreeCancellation({ startAt: atAruba("2026-08-10", "09:00") }, settings, atAruba("2026-08-08", "08:59"))).toBe(true);
  });
  it("is not free inside the window", () => {
    expect(isFreeCancellation({ startAt: atAruba("2026-08-10", "09:00") }, settings, atAruba("2026-08-08", "09:01"))).toBe(false);
  });
  it("boundary minute counts as inside the window", () => {
    expect(isFreeCancellation({ startAt: atAruba("2026-08-10", "09:00") }, settings, atAruba("2026-08-08", "09:00"))).toBe(false);
  });
});
```

Create `src/test/refunds.test.ts` following the repo's existing Stripe test double pattern (open `src/test/payments-webhook.test.ts` first and reuse its mock/`makePendingBooking` helpers):

```ts
import { describe, it, expect, vi } from "vitest";
import { refundPayment } from "@/lib/payments/refunds";
// reuse the suite's Stripe mock: stripe.refunds.create must be captured

describe("refundPayment", () => {
  it("refunds a succeeded payment in full by default and marks the row refunded", async () => {
    // seed: booking + payments row status succeeded, amountCents 3000, stripePaymentIntentId "pi_r1"
    const r = await refundPayment(paymentId);
    expect(stripeRefundCreate).toHaveBeenCalledWith({ payment_intent: "pi_r1", amount: 3000 });
    expect(r.refundedCents).toBe(3000);
    expect(r.status).toBe("refunded");
    // bookings.amountPaidCents decreased by 3000
  });
  it("partial refund keeps status succeeded and accumulates refundedCents", async () => {
    const r = await refundPayment(paymentId2, { amountCents: 1000 });
    expect(r.refundedCents).toBe(1000);
    expect(r.status).toBe("succeeded");
  });
  it("rejects refunding more than the remaining amount", async () => {
    await expect(refundPayment(paymentId3, { amountCents: 99999 })).rejects.toMatchObject({ status: 400 });
  });
  it("rejects non-succeeded payments", async () => {
    await expect(refundPayment(pendingPaymentId)).rejects.toMatchObject({ status: 409 });
  });
});
```

- [ ] Run to fail: `npm test -- --no-file-parallelism src/test/cancellation-policy.test.ts src/test/refunds.test.ts` — modules missing.
- [ ] Implement `src/lib/booking/cancellation.ts`:

```ts
import { parseTs } from "@/lib/time/format";

/** Free cancellation strictly BEFORE (startAt - cancellationWindowHours).
 *  At or inside the window (and no-shows): the deposit is not refunded. */
export function isFreeCancellation(
  booking: { startAt: string },
  settings: { cancellationWindowHours: number },
  nowIso: string,
): boolean {
  return parseTs(nowIso) < parseTs(booking.startAt) - settings.cancellationWindowHours * 3_600_000;
}
```

- [ ] Implement the `amounts.ts` extraction: move the pure block (types + `paymentAmounts` + `depositSettingsFromSnapshot`) from `charge.ts` into `src/lib/payments/amounts.ts` unchanged; `charge.ts` becomes `export { paymentAmounts, depositSettingsFromSnapshot } from "./amounts"; export type { PaymentOption, PaymentAmounts, DepositSettings } from "./amounts";` plus its remaining `chargeForBooking`/`Charge` code importing from `./amounts`. Run the Task 1 unit tests to confirm nothing broke.
- [ ] Implement `src/lib/payments/refunds.ts`:

```ts
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { payments, bookings } from "@/lib/db/schema";
import { getStripe } from "@/lib/payments/stripe";
import { Errors } from "@/lib/http/errors";

/**
 * Admin-initiated refund. Applies the result locally right away (dev has no
 * webhooks); the charge.refunded webhook later reconciles refundedCents to
 * Stripe's absolute amount_refunded, which is idempotent with this write.
 */
export async function refundPayment(paymentId: string, opts: { amountCents?: number } = {}) {
  const db = await getDb();
  return await db.transaction(async (tx) => {
    const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
    if (!p) throw Errors.notFound("Payment not found");
    if (p.status !== "succeeded" && p.status !== "refunded") throw Errors.conflict("Only settled payments can be refunded");
    if (!p.stripePaymentIntentId) throw Errors.conflict("No Stripe payment behind this row");
    const remaining = p.amountCents - p.refundedCents;
    const amount = opts.amountCents ?? remaining;
    if (amount <= 0 || amount > remaining) throw Errors.badRequest(`Refund must be between 1 and ${remaining} cents`);

    await getStripe().refunds.create({ payment_intent: p.stripePaymentIntentId, amount });

    const refundedCents = p.refundedCents + amount;
    const status = refundedCents >= p.amountCents ? "refunded" : p.status;
    await tx.update(payments).set({ refundedCents, status }).where(eq(payments.id, p.id));
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, p.bookingId)).for("update");
    if (b) await tx.update(bookings).set({ amountPaidCents: Math.max(0, b.amountPaidCents - amount) }).where(eq(bookings.id, b.id));
    return { refundedCents, status };
  });
}
```

(Adapt the `getStripe` import path to the repo's actual Stripe client module — grep `stripe.checkout.sessions.create` for it; keep `.for("update")` locking.)

- [ ] Create `src/app/api/admin/payments/[id]/refund/route.ts` following the repo's `withRoute` + `mutate` pattern (copy the shape of `src/app/api/admin/bookings/[id]/cancel/route.ts`), zod body `{ amountCents: z.number().int().positive().optional() }`, audit action `admin.payment_refunded`, returns the lib result.
- [ ] Run to pass: both new files green, then FULL suite green.
- [ ] Commit: `git add -A && git commit -m "feat(payments): pure amounts module, cancellation window policy, admin refunds"`

---

### Task 6: Customer cancellation applies the policy (auto-refund outside the window)

**Files:**
- Modify: `src/app/api/me/bookings/[id]/cancel/route.ts` (and its lib if the logic lives in `src/lib/booking/customer-bookings.ts` — grep `cancel` there first), `src/lib/email/templates.ts` (`bookingCancelledEmail` refund variant), `src/lib/email/notifications.ts`
- Test: `src/test/customer-cancel-policy.test.ts`

**Interfaces:**
- Consumes: `isFreeCancellation`, `refundPayment` (Task 5); `arubaNowIso` from `@/lib/booking/public`.
- Produces: customer cancel response gains `{ refunded: boolean, refundCents: number }`; `bookingCancelledEmail(args)` gains `refund: { refunded: boolean; refundCents: number }` in its args and renders one of two lines: "Your payment of $X has been refunded to your card." or "Cancelled within {H} hours of pickup: the deposit is not refunded, as per the cancellation policy."

- [ ] Write failing tests in `src/test/customer-cancel-policy.test.ts`: three cases — (a) cancel with `nowIso` 3 days before `startAt` refunds the succeeded payment (stripe refund mock called, response `refunded: true`), (b) cancel 12h before pickup does not call Stripe and returns `refunded: false`, (c) a booking with no succeeded payment cancels cleanly with `refundCents: 0`. Seed with the suite's booking + payment helpers.
- [ ] Run to fail.
- [ ] Implement: in the customer cancel path, after the status flip to `cancelled` succeeds, look up the booking's succeeded payments; if `isFreeCancellation(booking, settings, arubaNowIso())`, call `refundPayment(p.id)` for each succeeded payment (usually one); collect totals; pass the refund outcome into the cancellation emails (customer + admin variants). Never fail the cancellation because a refund errored: wrap the refund in try/catch, log loudly, and state "refund is being processed" in the email when it threw (the admin can retry from the Drawer).
- [ ] Run to pass; full suite green.
- [ ] Commit: `git add -A && git commit -m "feat(payments): customer cancellation auto-refunds outside the 48h window"`

---

### Task 7: Admin cancel gains a refund choice

**Files:**
- Modify: `src/app/api/admin/bookings/[id]/cancel/route.ts` (+ its lib `cancelBookingAdmin` — grep for it), `src/lib/email/notifications.ts`
- Test: `src/test/admin-cancel-refund.test.ts`

**Interfaces:**
- Consumes: `refundPayment` (Task 5), `isFreeCancellation` (Task 5).
- Produces: admin cancel body `{ refund: boolean }` (required — the UI always states the choice); response `{ refunded: boolean, refundCents: number, policySaysFree: boolean }`. The Drawer (Task 8) renders the choice using `policySaysFree` from a preflight `GET` of the booking.

- [ ] Failing tests: (a) `refund: true` refunds succeeded payments regardless of window (goodwill override), (b) `refund: false` never calls Stripe, (c) response carries `policySaysFree` computed from the booking + settings.
- [ ] Implement: thread `refund` through `cancelBookingAdmin`; audit action stays `admin.booking_cancelled` with `{ refund }` inside the audit `after` payload; emails state the refund outcome (reuse Task 6's template variant).
- [ ] Run to pass; full suite green. Commit: `git add -A && git commit -m "feat(admin): cancel with explicit refund or no-refund choice"`

---

### Task 8: BookingDrawer — the one-click booking surface

**Files:**
- Create: `src/app/admin/(shell)/booking-drawer.tsx`, `src/app/admin/(shell)/booking-drawer.css`
- Create: `src/app/api/admin/bookings/[id]/route.ts` (GET detail: booking + customer + payments + computed balance)
- Modify: `src/app/admin/(shell)/page.tsx` (bar click opens the Drawer; BookingPanel popover stays only for drag-create)
- Test: `src/test/admin-booking-detail.test.ts` (the GET route's lib), UI verified manually

**Interfaces:**
- Consumes: `Drawer, useToast, useConfirm` from `@/app/admin/_ui`; `formatDateTime`; `paymentAmounts`/`depositSettingsFromSnapshot` from `@/lib/payments/amounts`; refund route (Task 5); cancel route (Task 7).
- Produces (later tasks + wave 06 rely on these): `BookingDrawer` props `{ bookingId: string | null, onClose: () => void, onChanged: () => void }` exported from `src/app/admin/(shell)/booking-drawer.tsx`; a `sections` extension point: the Drawer renders, in order, Summary, Payments, `{extraSections}` (a `ReactNode` prop, default null — wave 06 injects Checklist + Inspections), Actions. Detail endpoint `GET /api/admin/bookings/[id]` returns:

```ts
{
  booking: { id, status, source, startAt, endAt, paymentOption, notes, priceBreakdown, amountPaidCents },
  customer: { name, email, phone },
  vehicle: { id, name, plate },
  payments: Array<{ id, type, method, amountCents, refundedCents, status, createdAt, stripePaymentIntentId }>,
  balanceDueCents: number,   // subtotal - amountPaidCents, floored at 0
  policySaysFree: boolean,
}
```

- [ ] Failing test for the detail lib (`getBookingDetail(id)` in a new `src/lib/admin/booking-detail.ts`): seeds a booking with one succeeded payment, asserts the shape above including `balanceDueCents` math and `policySaysFree`.
- [ ] Implement lib + GET route (`read` guard).
- [ ] Implement the Drawer component: Sand & Surf styling per the admin kit; Summary section (customer, vehicle + plate, `formatDateTime` period, status chip, source, notes); Payments section (one row per payment: type label, method, `$X.XX`, refunded badge when `refundedCents > 0`, status, a "Refund" button per succeeded row opening a small Modal with an amount input prefilled to the remaining amount + confirm → POST refund route); a bold "Paid $A · Balance due at pickup $B" line; Actions row: Move (reuses the existing move form flow), Extend (Task 10 wires it; render the button disabled with title "Extension arrives in the next task" until then — remove that in Task 10), Cancel (Modal with two buttons "Cancel and refund" / "Cancel without refund", defaulting focus per `policySaysFree`, both call Task 7's route).
- [ ] Wire the board: clicking a booking bar opens `<BookingDrawer bookingId=... />` instead of the popover detail; drag-create keeps the popover CreatePanel. `onChanged` refetches planning data.
- [ ] Verify: typecheck + lint + full suite green; manual — click a bar, see payments + balance, refund a test payment (Stripe test mode), cancel with/without refund.
- [ ] Commit: `git add -A && git commit -m "feat(admin): BookingDrawer with payments, balance due, refund and cancel actions"`

---

### Task 9: `extendBooking` — availability-checked, delta-priced, paid by link or desk

**Files:**
- Create: `src/lib/admin/extend-booking.ts`, `src/app/api/admin/bookings/[id]/extend/route.ts`
- Modify: `src/lib/payments/checkout.ts` (add `createExtensionCheckout`)
- Test: `src/test/extend-booking.test.ts`

**Interfaces:**
- Consumes: `checkAvailability(vehicleId, startAt, endAt, settings, { excludeBookingId })` (wave 01 Task 6 added the exclude option), `rentalDays`, `quote`, `addHoursIso`; payments `method`/type `extension` (Task 1); webhook extension handling (Task 2).
- Produces (seam): `extendBooking(bookingId: string, opts: { endAt: string, payment: "link" | "desk" }): Promise<{ booking, deltaCents: number, checkoutUrl: string | null }>`; route `POST /api/admin/bookings/[id]/extend` body `{ endAt: isoDateTime, payment: z.enum(["link","desk"]) }`, audit `admin.booking_extended`, bell `booking.extended`. Wave 05 Task 6 extends the re-quote to preserve the young-driver line — keep the breakdown construction in ONE clearly-marked block.

- [ ] Write failing tests in `src/test/extend-booking.test.ts`:

```ts
describe("extendBooking", () => {
  it("extends a confirmed booking, reprices the full duration, returns the delta", async () => {
    // booking: 2 days @ 8000/day => subtotal 16000, amountPaid 16000 (full)
    // extend +1 day: new subtotal 24000 => delta 8000
    const r = await extendBooking(b.id, { endAt: atAruba("2026-08-04", "09:00"), payment: "desk" });
    expect(r.deltaCents).toBe(8000);
    expect(r.booking.endAt).toContain("2026-08-04");
    // desk path: a succeeded payments row (type extension, method desk) exists; amountPaidCents grew by 8000
  });
  it("floors the delta at zero when tier pricing makes the longer rental cheaper", async () => { /* week-tier fixture */ });
  it("refuses when another booking occupies the extension window", async () => {
    await expect(extendBooking(b2.id, { endAt: laterIso, payment: "desk" })).rejects.toMatchObject({ status: 409 });
  });
  it("link path returns a checkout url and a pending extension payment row", async () => {
    const r = await extendBooking(b3.id, { endAt: laterIso, payment: "link" });
    expect(r.checkoutUrl).toMatch(/^https:/);
  });
  it("refuses statuses other than confirmed and picked_up", async () => { /* pending + completed cases -> 409 */ });
});
```

- [ ] Run to fail.
- [ ] Implement `extendBooking`: transaction with `for("update")` on the booking row; status guard (`confirmed` | `picked_up`); `endAt` must be strictly after the current `endAt`; availability check over `[currentEndAt, newEndAt)` with `excludeBookingId: bookingId`; re-quote the FULL new duration: current vehicle rates from `vehicles`, insurance daily price from `booking.insuranceSnapshot` (NOT the current catalog — the customer keeps their locked-in tier price), add-ons re-derived from `booking_add_ons` joined to `add_ons` for pricing mode with the SNAPSHOT unit interpretation (per_day lines scale to the new day count; per_rental lines unchanged); `deltaCents = Math.max(0, newBreakdown.subtotalCents - oldBreakdown.subtotalCents)`; update `endAt`, `bufferEndAt = addHoursIso(newEndAt, settings.turnaroundBufferHours)`, `priceBreakdown = newBreakdown`. Desk path: insert `payments` row `{ type: "extension", method: "desk", status: "succeeded", amountCents: deltaCents }` (skip when delta 0) and bump `amountPaidCents`. Link path: after commit, `createExtensionCheckout(booking, deltaCents)` — a sibling of the existing checkout creator with line name "Rental extension", metadata `{ bookingId, paymentType: "extension" }`, success url to the confirmation page, and a pending payments row (the webhook settles it per Task 2); return its url. `notifyAdmin({ type: "booking.extended", level: "info", title: ..., bookingId })` + customer email `bookingExtendedEmail` (create in `templates.ts`: new period via `formatDateTime`, delta amount, and either "paid at the desk" or "pay securely here: {link}").
- [ ] Route: `mutate` guard, audit `admin.booking_extended` with before/after dates + delta.
- [ ] Run to pass; full suite green.
- [ ] Commit: `git add -A && git commit -m "feat(admin): rental extensions with availability check, delta pricing, link or desk payment"`

---

### Task 10: Extend modal in the Drawer

**Files:**
- Modify: `src/app/admin/(shell)/booking-drawer.tsx`
- Test: manual (route logic covered by Task 9)

**Interfaces:**
- Consumes: `extendBooking` route (Task 9), `DatePicker` + `TimeSelect`, `useToast`.
- Produces: the Drawer's "Extend" button opens a Modal: new return `DatePicker` (min = current return date) + `TimeSelect`, a live delta preview (fetch: POST the extend route with a `dryRun: true` flag — ADD that flag to Task 9's route schema and lib as a no-write mode returning only `deltaCents`; 3-line change, do it in this task with a test appended to `src/test/extend-booking.test.ts`), then two action buttons: "Collected at desk" and "Send payment link". Success toast; link path also shows the URL with a copy button (`navigator.clipboard.writeText`). `onChanged()` refreshes the board.

- [ ] Append the `dryRun` test to `src/test/extend-booking.test.ts` (asserts no DB writes happen: booking endAt unchanged after a dryRun call). Run to fail; implement the flag; run to pass.
- [ ] Build the Modal UI; remove the Task 8 disabled state on the Extend button.
- [ ] Manual verify: extend a test booking both ways; the bar redraws longer; the payments list shows the extension row; the delta preview matches what gets charged.
- [ ] Commit: `git add -A && git commit -m "feat(admin): extend rental modal with live delta preview and payment choice"`

---

### Task 11: Step 7 rebuild — option cards, "You pay now", policy box, trust row, state persistence, resume payment

**Files:**
- Modify: `src/app/(public)/book/page.tsx`, the book flow CSS file (where `.opt`/`.note` live), `src/app/api/quote/route.ts` (response gains `policy`)
- Test: `src/test/quote-policy-meta.test.ts` (API meta), UI manual

**Interfaces:**
- Consumes: `paymentAmounts`/`depositSettingsFromSnapshot` from `@/lib/payments/amounts` (client-safe since Task 5); breakdown fields `depositPercent`/`depositMinCents` (Task 1); `siteConfig` (Task 4); checkout `cancel_url` with `&id=` (Task 1).
- Produces: `/api/quote` response body gains `policy: { cancellationWindowHours: number, securityDepositCents: number | null }` next to the breakdown; wizard sessionStorage key `"book-wizard-v1"`.

- [ ] Failing test `src/test/quote-policy-meta.test.ts`: POST `/api/quote` (reuse the existing quote route test harness) asserts `body.policy.cancellationWindowHours === 48` and `securityDepositCents` equals the vehicle's depositCents. Run to fail; implement in the quote route (settings + vehicle are already loaded there); run to pass.
- [ ] Rebuild the step 7 payment block in `book/page.tsx`. Replace the Task-1 interim radios with option cards. The amounts:

```tsx
import { paymentAmounts, depositSettingsFromSnapshot } from "@/lib/payments/amounts";

const amounts = quote ? {
  deposit: paymentAmounts(quote, "deposit", depositSettingsFromSnapshot(quote)),
  full: paymentAmounts(quote, "full", depositSettingsFromSnapshot(quote)),
} : null;
```

Cards markup (inside the step 7 card, replacing the radio block; `fmt` is the page's existing cents formatter):

```tsx
<div className="pay-options" role="radiogroup" aria-label="How would you like to pay?">
  <button type="button" className={`pay-card${paymentOption === "deposit" ? " selected" : ""}`} onClick={() => setPaymentOption("deposit")}>
    <span className="pay-card-title">Reserve with a deposit</span>
    <span className="pay-card-now">Pay {fmt(amounts.deposit.payNowCents)} now</span>
    <span className="pay-card-later">{fmt(amounts.deposit.balanceDueCents)} at pickup</span>
  </button>
  <button type="button" className={`pay-card${paymentOption === "full" ? " selected" : ""}`} onClick={() => setPaymentOption("full")}>
    <span className="pay-card-title">Pay in full</span>
    <span className="pay-card-now">Pay {fmt(amounts.full.payNowCents)} now</span>
    <span className="pay-card-later">Nothing due at pickup</span>
  </button>
</div>

<div className="policy-box">
  <p>Free cancellation until {policy.cancellationWindowHours} hours before pickup.</p>
  <p>Within {policy.cancellationWindowHours} hours or no show: the deposit is not refunded.</p>
  {policy.securityDepositCents !== null && (
    <p>Refundable security deposit of {fmt(policy.securityDepositCents)} due at pickup. You get it back at return.</p>
  )}
</div>

<div className="trust-row">
  <span className="trust-lock" aria-hidden>🔒</span>
  <span>Secure payment via Stripe. You will be redirected to Stripe and back.</span>
</div>

<p className="pay-now-line">You pay now: <strong>{fmt(amounts[paymentOption].payNowCents)}</strong></p>
```

Submit button text becomes `` `Pay ${fmt(amounts[paymentOption].payNowCents)} and reserve` `` (busy: "Reserving…"). CSS: `.pay-card` bordered cards, `.selected` gets the Deep Teal border + subtle background; `.policy-box` muted panel; `.pay-now-line` large near the button. Sidebar keeps "Rental total" but adds under it the muted line "You pay {fmt(payNow)} now" once step 7 is reached — the headline number the customer last sees MUST equal the Stripe amount.
- [ ] sessionStorage persistence: one `useEffect` serializing the wizard state (all step fields incl. licence + times) to `sessionStorage["book-wizard-v1"]` on change, one lazy `useState` initializer restoring it, `sessionStorage.removeItem` fired when the confirmation page mounts (add that in Task 12) AND after a successful checkout redirect begins.
- [ ] Resume path: on mount, read `?canceled=1&id=`; when present show a banner above the wizard: "Payment canceled. Your car is still held for about 30 minutes." with a "Resume payment" button that POSTs `/api/bookings/{id}/checkout` and redirects to the returned url, plus a "Start over" link clearing storage. Use `siteConfig` nothing here; keep copy dash free.
- [ ] Verify: typecheck, lint, suite; manual — book with deposit, confirm Stripe shows EXACTLY the "You pay now" number; back out of Stripe, land on the banner, resume, complete; refresh mid-wizard and confirm state survives.
- [ ] Commit: `git add -A && git commit -m "feat(book): honest pay-now step with policy box, persistence and resume payment"`

---

### Task 12: Confirmation page — patient polling + manual check + WhatsApp

**Files:**
- Modify: `src/app/(public)/book/confirmation/page.tsx`
- Test: manual (pure UI timing)

**Interfaces:**
- Consumes: `GET /api/bookings/[id]` (returns `startAt/endAt`, status, paymentOption, priceBreakdown), `siteConfig.whatsappHref` (Task 4), `formatDateTime`.
- Produces: nothing downstream.

- [ ] Implement: replace the 5×1.5s poll with backoff (4×1.5s, then 6×3s, then 7×5s ≈ 60s). While polling: "Checking your payment…" state. On confirmed: the existing success copy with `formatDateTime` times and a "Payment received: {fmt(amountPaidCents)}" line (extend the GET route to include `amountPaidCents` — additive field). After the last poll without confirmation: keep "Your car is reserved", add a "Check again" button (one more fetch per click) and, when `siteConfig.whatsappHref` is set, "Questions? Message us on WhatsApp" as a link. Clear `sessionStorage["book-wizard-v1"]` on mount.
- [ ] Verify manually with a slow-webhook simulation (complete a checkout with the webhook endpoint unreachable, then hit Check again after firing it). Typecheck + lint + suite green.
- [ ] Commit: `git add -A && git commit -m "feat(book): patient confirmation polling with manual check and WhatsApp fallback"`

---

### Task 13: Wave-02 final verification

- [ ] Full suite `npm test -- --no-file-parallelism` green; `npx tsc --noEmit`; `npm run lint`.
- [ ] Stop dev, `rm -rf .next`, `npm run build` → succeeds; restart dev.
- [ ] Manual end-to-end: (1) deposit booking — Stripe amount equals "You pay now", webhook confirms, `amountPaidCents` correct, Drawer shows paid/balance; (2) full booking — balance $0; (3) customer cancel outside 48h → auto refund visible in Drawer + Stripe test dashboard; (4) admin cancel inside window without refund; (5) extend by desk and by link (pay the link in test mode; webhook credits it); (6) abandon checkout → resume banner → resume → pay.
- [ ] Commit smoke fixes if any.
