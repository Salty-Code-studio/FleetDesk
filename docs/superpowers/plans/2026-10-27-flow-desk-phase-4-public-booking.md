# Flow Desk Phase 4: Public Booking in 3 Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the public booking wizard from 7 steps to 3 screens (When and what, Protect and add, You and pay) and move the driver's licence from booking to check-in.

**Architecture:** The server stops requiring a licence at booking; the claimed age band prices the booking. Check-in captures the full licence encrypted through a new staff-allowed admin route that also runs the age gate and reports a young-driver mismatch. The public page keeps its live-quote, persistence and Stripe logic; a pure `funnel.ts` module owns screen names, per-screen validation and migration of stored 7-step state.

**Tech Stack:** Next.js 15 App Router, React 19, plain CSS (`public.css`, `.pub` scope), zod, drizzle, Vitest (node, pglite).

**Spec:** docs/superpowers/specs/2026-10-14-yabi-flow-desk-design.html ("Public booking", decision "Booking funnel": seven steps to three screens, licence at check-in).

## Global Constraints

- Screens, verbatim: "When and what" (dates, times, car class, live price), "Protect and add" (insurance tier, extras, price still live), "You and pay" (name, email, phone, deposit or full).
- Price shows on screen one. The car hero: class name huge in the back, car in the middle, "Continue" on top.
- Coral means "tap this", one coral per view. On the public funnel the coral is the Continue / Pay button; the selected class uses teal, not coral.
- No "Step 1 of 3" / "01 / 03" labels in visible copy. No em-dashes in copy.
- Licence plaintext number and DOB are only ever stored via `encryptLicense`, never in `bookings.notes`.
- Money is always server-computed; the client never sends prices.

## Review Focus

- A customer mid-way through the old 7-step wizard (sessionStorage `book-wizard-v1`, step 5..7) reloads after deploy: lands on the right new screen, nothing crashes.
- An online booking with no licence reaches check-in: staff must capture the licence before handing over keys; an under-age DOB is refused there.
- Customer claims "25 or older" but the licence DOB says young: check-in shows the mismatch and the fee amount owed; nothing silently reprices.
- An old client (or the Stripe resume path) still posts a `license`: the server keeps validating and encrypting it as today.
- Deep links `?class=&pickup=&return=` still land pre-filled on screen one.

---

### Task 1: Licence optional at booking

**Files:** Modify `src/lib/booking/create.ts`; Test `src/test/booking-create.test.ts`.

- [ ] Test `it("books without a licence and prices by the claimed age band")`: `input({ license: undefined, youngDriver: true })` → booking created, `breakdown.youngDriver === true`, `priceAdjusted === false`, no `driverLicenses` row for the booking.
- [ ] Test the same with `youngDriver: false` → `youngDriverCents === 0`.
- [ ] `BookingCreateSchema.license` becomes `LicenseSchema.optional()`. When present: today's validate + band + encrypt. When absent: `youngDriver = input.youngDriver`, `priceAdjusted = false`, no licence insert.
- [ ] Commit `feat(booking): licence optional at booking, claimed age band prices it`.

### Task 2: Licence capture at check-in (server)

**Files:** Create `src/lib/admin/booking-license.ts`, `src/app/api/admin/bookings/[id]/license/route.ts`; Modify `src/lib/admin/inspections.ts` (handover gains `booking.youngDriver: boolean`, `booking.youngDriverFeeCents: number` = fee per day × days from settings); Test `src/test/booking-license-capture.test.ts`.

**Interfaces:** `saveBookingLicense(bookingId: string, license: LicenseInput, nowIso: string): Promise<{ band: "young" | "standard"; bookedYoung: boolean; mismatch: boolean }>`. `PUT /api/admin/bookings/:id/license` body `LicenseSchema`, `mutate(... "admin.license_saved", { roles: ["owner","staff"] })`, returns that object.

- [ ] Tests: saves an encrypted row (decrypts back); second save replaces it (one row); under-min DOB → 400 "Driver must be at least N years old"; cancelled booking → 409; booked standard + young DOB → `mismatch: true`; licence expiring before return → 400.
- [ ] Implement with `validateLicense` (rentalStart/End from the booking, today from `nowIso`) and `encryptLicense`; upsert on `bookingId`; `retainUntil = endAt + settings.licenseRetentionDays`. Never reprices.
- [ ] Commit `feat(checkin): capture the licence encrypted at check-in with the age gate`.

### Task 3: Licence capture at check-in (UI)

**Files:** Modify `src/app/admin/(shell)/inspect/[bookingId]/checkin/page.tsx`, `src/app/admin/(shell)/inspect/wizard-ui.tsx` (Handover type).

- [ ] When `data.license` is null, step 1 shows the licence form (name, number, country, DOB, issue, expiry; `DatePicker` with `licenceDateBounds`) and "Save licence" (PUT). Replaces the plaintext notes path.
- [ ] Next on step 1 is disabled until a licence is on file. Copy under the button: "Save the licence to continue."
- [ ] Mismatch result shows: "The licence says young driver. This booking was priced without the fee. Collect {fee} at the desk or change the price in the booking." (and the inverse: "…priced with the young driver fee, but the driver is {age}+. Refund the fee in the booking.")
- [ ] Commit `feat(checkin): licence form in step one, no plaintext licence in notes`.

### Task 4: Funnel logic

**Files:** Create `src/lib/booking/funnel.ts`; Test `src/test/booking-funnel.test.ts`.

**Interfaces:** `SCREENS = ["When and what", "Protect and add", "You and pay"] as const`; `type FunnelState = { selectedClass; pickup; ret; pickupTime; retTime; driverAge; available: boolean | null; customer: {name,email,phone}; acceptTerms }`; `validateScreen(n: 1|2|3, s: FunnelState): { message: string; field?: string } | null`; `screenFromStored(stored: { v?: number; step?: number }): 1|2|3` (v2 → clamp step to 1..3; legacy 7-step: 1-2 → 1, 3-4 → 2, 5-7 → 3).

- [ ] Tests: screen 1 needs dates, return after pick-up, both times, age band, a class, and `available !== false` (messages as today's wizard); screen 2 always valid; screen 3 needs name, email, phone, terms; legacy step 5 → 3, step 2 → 1, v2 step 9 → 3, missing → 1.
- [ ] Commit `feat(booking): three-screen funnel logic`.

### Task 5: Three-screen booking page

**Files:** Modify `src/app/(public)/book/page.tsx`, `src/app/(public)/public.css`.

- [ ] Storage key stays `book-wizard-v1`; write `{ v: 2, step }`; restore via `screenFromStored`. Drop `license` from state, storage and the POST body.
- [ ] Screen 1: dates + times + age band first, then class cards. Each card: class name at huge faint size behind, "from $X/day" and "N cars" in the middle; selected card = teal ring. Live total of the selected class shows under the cards once quoted ("$X for N days").
- [ ] Screen 2: insurance + extras on one card, two headings.
- [ ] Screen 3: details, pay choice, policy box, terms, then the submit button. Remove the price-adjusted notice path (no licence, no repricing).
- [ ] Stepper shows the three names only (no numbers, done screens clickable). Screen-reader live text: "{name}" only. Keep the summary sidebar.
- [ ] Commit `feat(booking): three screens, price on screen one, no licence step`.

### Task 6: Copy and pass

**Files:** `src/lib/email/templates.ts`, `src/app/(public)/book/confirmation/page.tsx` if it mentions the licence.

- [ ] Email line becomes "Bring your driver's licence. We check it when you pick up the car."
- [ ] `npx tsc --noEmit`, `npm run lint`, `npx vitest run`, `npm run build` all green; browser pass on the demo: book a car through all 3 screens in desk mode, then check in and save a licence.
- [ ] Commit `chore(booking): licence copy for check-in`.
