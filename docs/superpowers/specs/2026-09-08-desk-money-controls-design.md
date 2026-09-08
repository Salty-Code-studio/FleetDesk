# Desk money controls + licence date ranges

_Design, 2026-09-08. Product repo: `saltycodestudio-products/fleetdesk`. Ports downstream to `littlejohn-fleetdesk` and `tex-cars-app`._

## Why

Three complaints from Sjonnie (Little John Scooters), reported through Mo with screenshots of `app.littlejohnscooters.com`:

1. He sees a red hatched bar on the fleet board with `NOT PAID` in the tooltip, and there is no way to say the rental has been paid.
2. He sometimes settles a rental against something else instead of cash, and wants to type his own price.
3. The licence expiry date picker will not go past 2031. Customers already hold licences valid to 2036.

All three are desk-owner corrections to money and identity on a booking, so they ship as one wave.

### The drift problem

Little John is **ahead of** FleetDesk. The whole "paid until" feature exists only in the client fork and was never back-ported:

| Piece | FleetDesk | Little John | Tex Cars |
|---|---|---|---|
| `bookings.paid_until` column | absent | present (`src/lib/db/schema/bookings.ts:43`) | absent |
| `unpaid` / `paidUntil` on `PlanningBar` | absent | present (`src/lib/admin/planning.ts:21-22`) | absent |
| Red hatched bar + `NOT PAID` tooltip | absent | present (`admin/(shell)/page.tsx:415,480`, `admin.css:265`) | absent |
| `POST /api/admin/bookings/[id]/paid-until` | absent | present | absent |
| "Paid until" field in booking drawer | absent | present (`booking-drawer.tsx:356-362,456-461`) | absent |

So the work starts by back-porting that feature into the product, then building forward. Otherwise FleetDesk cannot express the paid state at all and every future port has to reason about which direction each file flows.

### Bug found during design

Little John's unpaid rule (`src/lib/admin/planning.ts:108-113`) reads:

```ts
unpaid: b.status === "picked_up" && (b.paidUntil
  ? b.paidUntil < todayLocal
  : Number((b.priceBreakdown as { totalCents?: number } | null)?.totalCents ?? 0) > 0 && ...)
```

Nothing in any of the three codebases ever writes `totalCents`. The quote engine writes `subtotalCents` (`src/lib/booking/quote.ts:115`) and manual bookings write `subtotalCents` (`src/lib/admin/manual-booking.ts:71`). The `> 0` guard is therefore always false and **the amount-based branch never fires**. In production today only a "paid until" date can turn a bar red, and Sjonnie does not know that field exists. The fix travels with this wave.

## Decisions locked with Mo

| Question | Decision |
|---|---|
| Does Sjonnie know about "paid until"? | No. This is a discoverability problem as much as a feature gap. |
| What should reports show for a bartered rental? | Whatever the owner types is the revenue. No separate barter payment method. |
| Who may change the price of an existing booking? | Owner only. Staff may still mark paid. |
| Keep "paid until" alongside amount-based paid? | Yes, both, clearly separated and labelled in the drawer. |
| Admin language | Stays English. |
| Reason for a price change | Required, free text. |

## Feature 1: licence date ranges

### Current behaviour

`DatePicker` derives its year dropdown from `min`/`max` when given, else `today - 100` to `today + 5` (`src/components/ui/DatePicker.tsx:343-355`). The three licence fields pass neither (`src/app/(public)/book/page.tsx:577-579`), so in 2026 all three offer 1926 to 2031. The escape hatch `Math.max(maxYear, viewYear)` only helps if a later value is already selected, so the dropdown cannot reach 2036.

Server side there are no bounds at all. `LicenseSchema` checks format only (`src/lib/booking/license.ts:11-20`) and `validateLicense` checks only ordering, validity through the return date, and driver age (`src/lib/booking/license.ts:56-70`).

### Change

Pass explicit ranges per field at the call sites:

| Field | min | max |
|---|---|---|
| Date of birth | today minus 100 years | today |
| Issue date | today minus 50 years | today |
| Expiry date | today | today plus 25 years |

25 years forward covers 2036 comfortably and the longer Aruban and Bonairian licence terms.

Add matching bounds server side in `validateLicense`, so the same rules hold for any caller:

- date of birth must not be in the future
- issue date must not be in the future
- expiry date must not be more than 25 years out

These are new rejections. Existing bookings are untouched; only new submissions are validated.

Sweep every other `DatePicker` call site in the app for the same missing-range problem rather than fixing only these three.

## Feature 2: paid state

Two mechanisms live side by side in the drawer's money section, each under its own heading so it is obvious which is which.

### 2a. Amount received (ordinary rentals)

The money section shows price, paid so far, and balance due. Below it:

- **Mark as paid** button: posts the full `balanceDueCents` to the existing `POST /api/admin/bookings/[id]/desk-payment`
- **Other amount** link: opens an amount input for a partial payment, posting to the same route

No new endpoint. `recordDeskBalancePayment` (`src/lib/admin/inspections.ts:95-122`) already row-locks the booking, inserts a `{type: "balance", method: "desk", status: "succeeded"}` payment, bumps `amountPaidCents`, and rejects overpayment. Audit logging is automatic through `mutate()` (`src/lib/admin/guard.ts:31-58`).

**One change required.** That route currently rejects bookings in `cancelled` **or** `completed` state (`src/lib/admin/inspections.ts:105-107`). Sjonnie routinely settles up after the scooter is back, so `completed` must be allowed. `cancelled` stays rejected.

Available to owner and staff.

### 2b. Paid until (rolling monthly rentals)

The date field from Little John, back-ported unchanged in behaviour: a `DatePicker` with Save, +1 month, and Clear. Backed by `bookings.paid_until` (a nullable `date`) and `POST /api/admin/bookings/[id]/paid-until`, audit action `admin.paid_until_set`. It never touches the payments ledger, it is purely a coverage marker.

The heading explains what it is for, something like "For rentals paid by the month. Set the last day the customer has covered."

The two mechanisms are independent. **Mark as paid does not set or clear `paid_until`**, and setting `paid_until` does not record money. An owner using monthly rentals will typically use only 2b; an owner doing day rentals will use only 2a. Nothing forces a choice, and section 2c defines which one wins when both are populated.

### 2c. The red bar on the fleet board

Rule: a bar is unpaid when the rental is `picked_up` **or** `completed`, and money is outstanding.

- If `paid_until` is set, it decides: unpaid once that date is in the past.
- Otherwise the balance decides: unpaid when `subtotalCents > amountPaidCents`.

Two deliberate differences from Little John's current behaviour:

- `totalCents` becomes `subtotalCents`, so the amount branch actually fires
- `completed` joins `picked_up`, because a finished unpaid rental is exactly the money the owner loses and it currently disappears from the board the moment the scooter comes back

The drawer states in plain words which of the two rules is currently colouring the bar, for example `Unpaid: $120 still due` or `Unpaid: paid until 31 Aug`. This is the discoverability fix. Today a red bar appears with no explanation and no visible control.

Tooltip text becomes informative rather than a bare flag: `unpaid, $120 due` or `paid until 31 Aug`, in English.

### Data flow

`src/lib/admin/planning.ts` gains `amountPaidCents`, `priceBreakdown`, and `paidUntil` in its select (`:73-83`), derives `unpaid` and `paidUntil` onto `PlanningBar` (`:12-22`), which flows to `Bar` (`admin/(shell)/page.tsx:22`) and the two tooltip templates (`:414`, `:479`), plus the `.pl-bar--unpaid` hatch class and a legend entry.

## Feature 3: owner price override

### Route

`PATCH /api/admin/bookings/[id]/price`, owner only, following the precedent set by the owner-only guard in `src/lib/admin/extend-booking.ts:69-71`.

Body: `{ subtotalCents: number, reason: string }`. `reason` is required, trimmed, minimum 3 characters, maximum 500.

### How the price is stored

`priceBreakdown` is untyped jsonb (`src/lib/db/schema/bookings.ts:33`) and the contract PDF builds its line items from the individual fields inside it (`src/lib/admin/inspections.ts:273-306` feeding `src/lib/pdf/contract.tsx`). Overwriting the breakdown with a flat amount would leave a contract whose line items do not sum to its total.

So the override **preserves** the existing breakdown and adds to it:

```jsonc
{
  ...existingBreakdown,
  "subtotalCents": <new value>,
  "adjustmentCents": <new value - previous subtotalCents>,  // signed
  "priceOverride": {
    "previousSubtotalCents": <old>,
    "reason": "settled against Dirk's key work",
    "byAdminId": "<admin id>",
    "at": "<ISO timestamp>"
  }
}
```

The contract PDF and the check-in money panel render an extra `Adjustment` line when `adjustmentCents` is present and non-zero, so the lines still add up to the total. A repeated override recomputes `adjustmentCents` against the *original* subtotal, which is preserved because `priceOverride.previousSubtotalCents` is only written on the first override and left alone afterwards.

### Guards

The route refuses, with a clear message, when:

- **`subtotalCents < amountPaidCents`.** Would create a negative balance. Message directs the owner to record a refund first.
- **A payment row is `pending` on this booking.** In online mode the Stripe amount is computed from the snapshot at session-create and re-checked at webhook reconcile (`src/lib/payments/checkout.ts:46`, `src/lib/payments/webhook.ts:90`). Editing mid-checkout desyncs the two. Little John and Tex run desk mode so this cannot bite them, but the demo runs online mode.
- **Booking status is `cancelled`.**

Runs inside a transaction with `SELECT ... FOR UPDATE` on the booking row, matching `extend-booking.ts` and `move-booking.ts`.

### Audit

Through `mutate(req, "admin.booking_price_changed", ...)`, recording before and after subtotal plus the reason. This is the control that replaces a staff-level restriction.

### UI

In the drawer money section, visible to owner only: a **Change price** action opening a `MoneyInput` and a required reason field. After a successful change the section shows the adjustment and the reason inline.

No confirmation email is re-sent. For a barter settlement that would be actively wrong. The drawer shows a one-line note that the customer's original confirmation email still shows the old price, so the owner can follow up by hand if it matters.

### Downstream, no code change needed

Revenue and per-car reports read `subtotalCents` (`src/lib/admin/reports.ts:61,186`), and balance due is `subtotalCents - amountPaidCents` (`src/lib/admin/booking-detail.ts:73`). Both follow the override automatically, which is exactly the "what he types is the revenue" decision.

One consequence to accept: `reports.ts:186` skips bookings whose subtotal is `<= 0`, so a rental overridden to zero drops out of the per-car revenue matrix. That is consistent with the decision and is not changed here.

## Port strategy

### Order

1. **FleetDesk.** Back-port paid-until, fix the `totalCents` bug, then build all three features. Full suite green before anything moves downstream.
2. **Little John.** Already has paid-until, so it receives only the bug fix and the new work. **No migration needed**, because the price override lives in existing jsonb. Lowest-risk client port, and it is where the complaints came from.
3. **Tex Cars.** Receives everything including the `paid_until` migration.

### Preconditions

- FleetDesk sits on `feat/branded-emails` with uncommitted changes (`.gitignore` hardening, a regenerated `next-env.d.ts`, and an untracked `supabase/.temp/`). Resolve before new work: commit the gitignore change, add `supabase/.temp/` to it.
- **Little John has four unpushed commits on `main`** (`edc955d`, `d018f09`, `f8f0b05`, `66d2f7e`, including the 2FA issuer brand-leak fix and the email dark-mode fix). These exist only on the local machine. Push before porting anything on top.
- Back up the production database before the Tex migration.

### Known deployment gotchas, carried from project notes

- Tex Cars: the marketing site deploys by subtree push to `gh-pages`; a push to `main` alone does nothing. The app deploys via `crane push` plus `wrangler`. Colima's docker disk at 85 percent or above silently kills container builds, so prune the builder first.
- Little John: never change the worker `INSTANCE_ID`. A new Durable Object means no env injection and a site-wide 500.
- FleetDesk demo: Vercel deploys are manual CLI. `.env.supabase` holds a stale password; never reset the database password on its own, because Vercel's sensitive `DATABASE_URL` holds the live one. One-off DDL goes through the Supabase Management API query endpoint.

## Out of scope

- A separate "barter" or "settled" payment method. Explicitly decided against: the typed price is the revenue.
- Per-tenant configuration of who may change prices. Owner-only is hard-coded.
- Translating the admin interface. It stays English.
- Re-sending customer emails after a price change.
- Any change to how prices are quoted for new bookings.

## Testing

- **Licence dates**: unit tests that the picker offers 2036 for expiry and refuses a future date of birth; server tests for each new bound in `validateLicense`. Existing tests in `src/test/booking-license.test.ts` and `src/test/young-driver.test.ts` must stay green.
- **Paid state**: a test proving the amount-based unpaid branch fires, which is the regression Little John's `totalCents` bug would have caught. Tests for paid-until overriding the amount rule, for `completed` bookings being flagged, and for `cancelled` never being flagged. Port and extend Little John's `src/test/admin-planning.test.ts`.
- **Desk payment on completed bookings**: a test that a `completed` booking accepts a payment and a `cancelled` one does not.
- **Price override**: tests for each of the three guards, for the adjustment line appearing on the contract, for repeated overrides keeping the original subtotal, for staff receiving a 404, and for the audit row carrying the reason.
- **End to end**: drive the admin board in a browser and confirm a red bar turns neutral after Mark as paid, and that a price change reflows the balance. Tests alone do not prove the discoverability fix worked.

## Risks

- **The `completed` relaxation widens who can record money against a finished rental.** Mitigated by the existing overpayment guard and the audit log, but it is a real loosening of a deliberate restriction.
- **`priceBreakdown` is untyped jsonb**, so adding fields is not type-checked. Every reader was inventoried during design; the two fragile groups are the ones that cast to the full `QuoteBreakdown` shape without fallbacks (`checkout.ts`, `webhook.ts`, `booking-detail.ts`, `notifications.ts`, `approval/message.ts`) and the defensive ones that fall back to zero (`inspections.ts`, `reports.ts`). The override only adds keys and changes `subtotalCents`, both of which every reader already handles.
- **Two competing sources of truth for paid state.** Accepted deliberately, mitigated by the drawer stating which rule is active. If it confuses Sjonnie in practice, the fallback is to drop paid-until in favour of monthly partial payments.
