# FleetDesk Feature Wave — Design Spec

**Date:** 2026-07-27 · **Status:** approved by Mo (decisions gathered interactively; client wish list folded in)
**Builds in:** FleetDesk (`~/Desktop/SaltyCode/04-Products/saltycodestudio-products/fleetdesk`)
**Ports to:** Tex Cars app (`~/Desktop/SaltyCode/03-Clients/saltycodestudio-clients/tex-cars-rental/app`) at the END of the wave (user decision: build first, port at the end).
**Execution:** subagent-driven development, implementers on **Opus**, review between tasks.

---

## Scope (eight workstreams)

1. **Time-aware booking** — pickup/return times on daily rentals, time-aware grid, time blocks, richer bar states
2. **Payment redesign + extensions** — deposit-or-full choice, honest amounts, cancellation policy, admin payments UI, rental extension with new payment
3. **Compliance alerts** — insurance + inspection expiry dates, staged alerts, dashboard visibility
4. **Check-in / check-out** — staff-guided wizard: license photo, damage photos, rules, signature, contract PDF, borg handling, checklist surfacing
5. **Under-21 young-driver surcharge** — 18–20 allowed with per-day fee
6. **Fleet management upgrades** — make/model/year/color, grouping + search, per-car notes
7. **Reports upgrade** — revenue per car per month + yearly, PDF export, borg separated from profit
8. **Staff logins** — per-person login codes, who-logged-in visibility, role-scoped permissions

Then: **Tex Cars port** — full parity (security fixes + admin kit + wizard + this wave), consolidated at the end, including Tex data tasks (retire A-plate cars).

Out of scope: multi-tenancy, Stripe Connect, embeddable widget, hourly pricing, seasonal pricing.

**Design principle (client ask): less clicking.** One click from a planning-board bar opens a booking Drawer with everything (detail, checklist, payments, actions); checklist items are single-tap toggles; frequent actions get command-palette entries.

---

## Current-state facts the design relies on (verified 2026-07-27)

- All booking storage is **day-granularity** `date` columns (`bookings.start_date/end_date/buffer_end_date`), semantics `[start, end)` exclusive end. Overlap safety is a Postgres exclusion constraint `bookings_no_overlap` on `daterange(start_date, buffer_end_date)` filtered to `status IN ('pending','confirmed')` (drizzle/0002 + 0007).
- Advisory checks in `src/lib/booking/availability.ts` (`checkAvailability`, `validateDates`); zod `isoDate` (`src/lib/validation/iso-date.ts`) rejects anything but `yyyy-mm-dd` at every route boundary.
- Public wizard is one client component `src/app/(public)/book/page.tsx`, 7 steps; customers book a **class**, one free car is resolved per class (`src/lib/booking/classes.ts`).
- Pricing: server-only `quote()` in `src/lib/booking/quote.ts` — day/week/month tier DP, per-day insurance, per_day/per_rental add-ons; snapshot to `bookings.price_breakdown` jsonb. Stripe charge derived only from the snapshot (`src/lib/payments/charge.ts`, `checkout.ts`).
- Payments: Stripe **hosted Checkout only**; webhook (`/api/webhooks/stripe`) is the single money-truth flip with event-id dedup + amount re-verification. `payments` table with one-pending-per-booking partial index. `refunded` status exists but is never written. **No admin payments UI at all.**
- Known payment-UX defects (the "scammy" feel): step 7 headline shows "Rental total" while the button charges a much smaller amount only visible inside a radio label; "cash deposit at pick-up" still triggers an online card charge; fee-vs-deposit relationship never explained; `?canceled=1` is read by no code (backing out of Stripe wipes all 7 steps of wizard state incl. licence PII); abandoned pending bookings block the customer's own class for hours; confirmation page gives up polling after ~8s; admin can't see or refund payments.
- Admin: planning board at `/admin` IS the availability grid (rows = vehicles by class, columns = days, % positioned bars, drag to create/move, popover detail). No bookings list page (disabled "Bookings (Plan 04)" nav placeholder). Booking status enum `pending|confirmed|cancelled|completed` — **nothing ever writes `completed`**; no pickup/return step exists.
- Manual desk bookings (`createManualBooking`) and drag-moves (`moveBooking`) deliberately **skip** block/blackout checks — only the DB constraint stops them.
- `vehicles` columns today: slug, plate, class, **name** (single string — no make/model/year/color), seats, transmission, ac, doors, photos jsonb (pasted URL strings), price tiers, depositCents, status. **Zero compliance fields; no file upload/object storage exists anywhere** (`driver_licenses.documentRef` is an unimplemented placeholder anticipating "private object storage + short-lived signed URLs").
- Notifications: durable bell (`notifications` table + `notifyAdmin()`), Resend email (`sendAndLog`, always logs to `email_log`), dormant WhatsApp (`sendOwnerWhatsApp`, activates via env). One Vercel cron exists (`/api/cron/expire-holds`, bearer `CRON_SECRET`) — the pattern to copy. No dedup mechanism for recurring alerts.
- Settings singleton table (id=1): `reservationFeeCents` (3000), `currency`, `minDriverAge` (21, under-age = hard 400 reject in `validateLicense`), `turnaroundBufferDays`, min/max rental days, `maxAdvanceDays`, `licenseRetentionDays`, `adminAlertRecipients`.
- DOB collected only at licence step, validated then AES-256-GCM encrypted (`driver_licenses.dobEnc`); **not available at quote time** and never re-readable — any age-derived pricing must be snapshotted.
- Admin auth: session + mandatory TOTP; `mutate()` guard audit-logs every action with the admin user; roles `owner|staff` exist but every route defaults to owner-only (staff currently 403s everywhere).
- Admin UI kit to reuse: `Modal, Drawer, useToast, useConfirm, Skeleton, EmptyState, registerPaletteAction` from `@/app/admin/_ui`; `DatePicker, Select` from `@/components/ui`. Strict CSP, no external assets.
- Reports today: `/admin/reports` KPIs (revenueByMonth, revenueByClass, topVehicles, utilizationPct) derived from booking `priceBreakdown` snapshots of confirmed/completed bookings, month-sliced by overlap days (`src/lib/admin/reports.ts`). No per-car matrix, no export, no deposit separation.
- Tex divergence: 145 of 182 shared files byte-identical; booking engine + migrations 0000–0013 identical. FD-only: Sand & Surf admin kit + redesign, book wizard, marketing funnel (+`leads` schema, migration 0014), 4 security fixes (OTP-leak takeover, per-scope rate limits, guest CSRF, Next 15.5.20), demo door. No shared git ancestry but fork-point content == Tex HEAD, so cherry-pick/git-apply applies mostly clean. Tex has real 34-car seed + branding that must be protected. Tex open item: 4 oldest Suzukis still on A-plates (A-71203, A-68405, A-21141, A-67530). No CI in either repo; `npm test` (vitest, `--no-file-parallelism`) is the regression gate. FD ~199 tests, Tex ~186.
- Dev DB is PGlite (`pglite://`), prod is Supabase Postgres (postgres-js). Migrations via `npm run db:generate` / `db:migrate` (`scripts/migrate.ts`), hand-written SQL allowed (0002, 0010 precedent).

---

## Workstream 1 — Time-aware booking

**Model decision (Mo):** rentals stay priced per day; customers pick pickup + return times; grid shows partial-day occupancy; admin can block time ranges. Implementation decision: **full timestamp migration** (no bolt-on time columns).

### Schema & data
- `bookings`: `start_date/end_date/buffer_end_date` (date) → `start_at/end_at/buffer_end_at` (timestamptz). Migration converts existing rows: start = date at 09:00 America/Aruba; end = exclusive return day at 09:00 (preserves the `[start,end)` span); buffer likewise.
- Exclusion constraint rebuilt: `EXCLUDE USING gist (vehicle_id WITH =, tstzrange(start_at, buffer_end_at, '[)') WITH &&) WHERE (status IN ('pending','confirmed','picked_up'))` — now also covers the new `picked_up` status (workstream 4) so a car that's out can never be double-booked. Hand-written migration (0002/0007 precedent).
- `availability_blocks`: `start_date/end_date` → `start_at/end_at` timestamptz (existing rows convert as 00:00→24:00 local spans).
- `blackout_dates`: **stays date-based** (island-wide whole-day closures; applied as full local days in availability logic).
- `settings`: `turnaroundBufferDays` → `turnaroundBufferHours` (migrate value × 24); new `openingTime`/`closingTime` (text "HH:MM", defaults "08:00"/"18:00") constraining selectable pickup/return times.

### Validation & API
- New zod `isoDateTime` (ISO 8601 with offset) alongside `isoDate`. Public quote/availability/classes/bookings APIs accept datetime; **date-only values remain accepted for backward compat** (Phase-1 Tex site deep links `?pickup=YYYY-MM-DD`) and default to openingTime.
- `validateDates`: min/max rental still in whole days (computed from timestamps); adds business-hours check (pickup/return time within opening–closing, 30-min steps); past-check against Aruba now.
- `checkAvailability` overlap math moves to timestamps; buffer = `end_at + turnaroundBufferHours`.

### Pricing
- `rentalDays() = Math.max(1, Math.ceil((end - start) / 24h))` — 09:00→09:00 next day = 1 day; 09:00→12:00 next day = 2 days. No grace period in this wave (future setting if the operator asks).
- Quote DP unchanged above the day count.

### UI
- Wizard step 2: pickup date + time, return date + time. New `TimeSelect` component (30-min steps within business hours) beside the existing `DatePicker` — same Sand & Surf styling, added to `@/components/ui`.
- Planning board: day columns stay; bars positioned fractionally within the day (a 12:00 return ends the bar mid-column; a 14:00 pickup starts mid-column). Bar labels/popover show times. Drag-create still snaps to days (popover then allows time editing); drag-move preserves time-of-day. **Manual booking CreatePanel gains day + time fields (client ask: "when choosing car, day & time").** ServiceModal + Fleet blocks drawer gain time fields.
- **Bar visual states (client ask):** distinct colors/treatments for `pending`, `confirmed`, `picked_up` (checked in), **due-back-soon** (picked_up with return within 24h), **overdue-return** (picked_up past return time), `completed`, blocked. Legend updated.
- Emails/confirmation/account pages render "date at HH:MM" via a shared formatter.

### Hardening (found during mapping, in scope)
- `createManualBooking` and `moveBooking` now run the block/blackout advisory check and return a structured conflict the UI surfaces as a confirm dialog ("This car is blocked for maintenance then — book anyway?"). Override allowed (desk knows best), silent collision does not happen anymore.

---

## Workstream 2 — Payment redesign + rental extensions

**Model decision (Mo):** customer chooses **deposit to reserve** or **pay full amount**. Cancellation: free until **48h before pickup**; inside 48h and no-shows: **no refund**. The card-charging "cash deposit" option is removed.

### Money model
- Deposit = `max(depositPercent × rentalTotal, depositMinCents)`, both in settings: `depositPercent` (int, default 25), `depositMinCents` (rename/migrate of `reservationFeeCents`, default 3000). Full = rental total (vehicle + insurance + extras + surcharges).
- `payment_option` enum → `deposit | full` (migration maps `reservation_fee`→`deposit`, `full_deposit`→`deposit`, `cash_deposit`→`deposit`; historical rows keep meaning "partial paid online").
- The **security deposit / borg** (`vehicles.depositCents`) is NOT charged online anymore — it becomes an "at pickup" information line, clearly labeled refundable, in wizard + emails + contract. Its lifecycle is tracked at check-in/out (workstream 4) and reported separately (workstream 7).
- QuoteBreakdown gains: `payNowCents` (per chosen option), `balanceDueCents` (total − paid), and the young-driver line (workstream 5). Booking rows gain `amount_paid_cents` (updated by webhook) so balance-due is queryable.
- New settings: `cancellationWindowHours` (default 48).

### Customer UX (step 7 rebuild)
- Two option cards (not radios buried in text): **"Reserve with deposit"** (Pay $X now · $Y at pickup) and **"Pay in full"** (Pay $Z now · nothing due at pickup). Selected card drives one prominent **"You pay now: $N"** line directly above the button; button copy becomes "Pay $N and reserve".
- The number Stripe shows will exactly match "You pay now" — the #1 trust fix.
- Policy box next to the button: "Free cancellation until 48h before pickup. Within 48h or no-show: deposit not refunded. Refundable security deposit of $D due at pickup." (copy pulls the configured window; dash-free house style).
- Trust row before the button: "Secure payment via Stripe" + card brand marks (self-hosted assets, CSP-safe), plus "You'll be redirected to Stripe and back."
- Wizard state persists to `sessionStorage` (cleared on confirmation); returning from Stripe via `cancel_url` (`?canceled=1&id=<bookingId>`) is **handled**: wizard restores, shows "Payment canceled — your car is still held for N minutes" with a **Resume payment** button hitting `POST /api/bookings/[id]/checkout` again (endpoint already expires stale sessions safely).
- Confirmation page: poll up to 60s with backoff, then a manual "Check again" button + WhatsApp contact link; copy acknowledges the "if you just paid" state honestly.
- Public layout header brand/link becomes config-driven (env/site config) instead of hardcoded fleetdesk.app — also makes the Tex port a config change, not string surgery.

### Cancellation & refunds
- Customer cancel (`/api/me/bookings/[id]/cancel`): if now ≤ pickup − window → auto Stripe refund of captured payment (`stripe.refunds.create`), payment row → `refunded` (the dead enum value gets a writer), booking → cancelled, emails state the refund. Inside window: booking cancels, no refund, email states policy.
- No-show: no automation (booking simply never picks up); admin cancel flow offers a refund/no-refund choice with the policy shown.
- Admin refund action can always refund manually regardless of window (goodwill override).

### Rental extension (client ask: "extend rentals, add extra days → new payment, pop up")
- Booking Drawer action **"Extend rental"** (statuses confirmed / picked_up): Modal with new return date + time → availability check for the same vehicle over the extended span (other bookings, blocks, blackouts; conflict shown clearly) → **delta price** = quote(full new duration) − original snapshot subtotal, floored at 0 (tier DP can make longer cheaper per day; never charge negative).
- Payment for the delta, staff picks in the popup: **(a) send payment link** — creates a Stripe Checkout for the delta (payments.type `extension`), link copyable/WhatsApp-able to the customer, webhook confirms; or **(b) collected at desk** — records a desk payment row (`method: desk`) immediately.
- On success: `end_at`/`buffer_end_at` updated, snapshot replaced with the new full-duration breakdown (original preserved in the payments/audit trail), `amount_paid_cents` updated, customer gets an updated-booking email, bar redraws. Audit `admin.booking_extended`.
- DB: `payments.type` gains `extension`; payments gain `method` (`stripe | desk`, default stripe).

### Admin payments surface
- Booking Drawer payments section: each charge (type, method, amount, status, created, Stripe link), **amount paid / balance due at pickup**, and a **Refund** button (full or custom amount, confirm dialog, audit-logged `admin.payment_refunded`, webhook `charge.refunded` reconciles status).
- Dashboard "awaiting payment" KPI unchanged.

---

## Workstream 3 — Compliance alerts (insurance + inspection)

Client ask: insurance expiry with a notification **one week before**, plus the yearly inspection (a date that differs every year), visible **in the dashboard**.

- `vehicles` gains: `insurance_expires_on date`, `inspection_due_on date` (both nullable), plus `insurance_alert_stage`/`inspection_alert_stage` (smallint, default 0) as dedup markers.
- Fleet admin: two DatePicker fields in the vehicle form; list badges — amber "Insurance 23d" / "Inspection 9d" when ≤30 days, red "Overdue" past due.
- New cron `GET /api/cron/compliance-alerts` (daily, vercel.json entry, `CRON_SECRET` bearer — copy of the expire-holds pattern). Stages per vehicle per document: **30d → 7d → overdue** (7d = the client's "one week before"); fire when current stage > recorded stage; entering a new future date resets the stage to 0. Firing = bell (`notifyAdmin`, warning / critical when overdue) + owner email (`alertOwner`, new `adminDocumentExpiringEmail` template) + WhatsApp automatically when env is configured. After the inspection is done, the owner simply enters next year's date — the stage resets, satisfying "differs every year".
- **Dashboard card:** compliance panel on `/admin` listing vehicles expiring ≤30d or overdue (click-through to Fleet), so it's visible without waiting for an email.
- Settings: `complianceAlertDays` (default 30) for the first-warning threshold; 7d + overdue stages fixed.
- No document file attachments this wave (storage exists after workstream 4; attaching scans is a cheap follow-up, noted as future).

---

## Workstream 4 — Check-in / check-out

**Decision (Mo):** staff-device guided wizard (admin auth); customer is handed the device to read rules + sign. Client asks folded in: **checklist buttons** (agreement signed, rules signed, licence copy received, etc.), a **borg button** at check-out, colors for checked-in/near-checkout (workstream 1 bars).

### Storage layer (new, shared infra)
- `src/lib/storage/` abstraction: `putObject(key, bytes, contentType)`, `getSignedUrl(key, ttl)`, `deleteObject(key)`. Drivers: **Supabase Storage** (private bucket `fleet-docs`, service-role key, short-lived signed URLs — exactly what the `documentRef` comment anticipated) and **local-disk** (dev/test: `.dev-storage/`, dev-only signed route). Driver chosen by env (`STORAGE_DRIVER=supabase|local`).
- Upload path: `POST /api/admin/uploads` (multipart, `mutate` guard, size cap ~10MB, jpeg/png/webp only); client compresses/downscales photos before upload (canvas, longest edge ~1600px).

### Data model
- Booking status enum gains `picked_up`: `pending → confirmed → picked_up → completed` (+ `cancelled`). Exclusion constraint predicate updated (workstream 1). `completed` finally gets a writer (check-out).
- New table `inspections`: `id`, `booking_id` FK, `kind` (`pickup | return`), `odometer int`, `fuel_level` (eighths `0..8`), `notes`, `photos jsonb` (`[{key, label}]` storage refs), `license_photo_key`, `signature_key` (pickup), `contract_pdf_key` (pickup), `damage_flags jsonb` (return: `[{photoKey, note}]`), `accepted_policy_version`, `created_by` admin FK, `created_at`. Unique on (booking_id, kind).
- **Checklist state** on the pickup inspection row (single-tap toggles, client ask): `agreement_signed`, `rules_signed`, `license_copy_received`, `borg_received` (booleans + who/when). Return inspection: `borg_returned` (the "borg button"), `keys_returned`. The checklist renders in the booking Drawer from the moment of check-in, so the dashboard answers "did we get X?" at a glance.

### Check-in wizard (admin, mobile-first)
Entry: booking Drawer button "Check in" (status confirmed; pending allowed with a desk override note). Steps:
1. **Verify** — booking summary, balance due at pickup, licence details on file (manual bookings have none — wizard collects name + licence number then). Balance can be marked collected (desk payment row, workstream 2).
2. **Licence photo** — camera capture (`<input capture="environment">`), private bucket, key on the inspection; toggles `license_copy_received`.
3. **Walk-around photos** — guided minimum 6 angles (front, back, left, right, interior, dash/odometer), each labeled; extra damage close-ups with notes.
4. **Odometer + fuel** — numeric + eighths selector.
5. **Borg** — record security deposit received (amount + cash/card toggle) → `borg_received`.
6. **Rules + signature** — device handed to customer: renders the current versioned rental terms (existing `policies` table), scrollable, then a signature canvas (pointer/touch draw → PNG). Sets `rules_signed` + `agreement_signed`, records accepted policy version.
7. **Finish** — booking → `picked_up`; contract PDF generated server-side (`@react-pdf/renderer`): operator + customer details, vehicle, period with times, price breakdown, balance, borg, policy version, signature image, photo manifest. Stored + emailed to customer. Bell `booking.picked_up`.

### Check-out wizard
1. **Return photos** — same 6 angles, shown **side-by-side** with the pickup photo of the same label.
2. **Damage review** — per angle "same / new damage"; new damage requires a note (+ optional close-up). Flags stored on the return inspection.
3. **Odometer + fuel** — with delta vs pickup shown.
4. **Borg return** — the borg button: mark security deposit returned in full / partially withheld (amount + reason, required when damage was flagged) / withheld. Feeds workstream 7 reporting.
5. **Finish** — booking → `completed`; optional return-summary email; bell `booking.returned` (warning level when damage flagged).

### Admin viewing
- Inspection detail in the booking Drawer: checklist state, photo grid via signed URLs, contract download, signature, odometer/fuel pair, damage flags. Audit: `admin.checkin_completed`, `admin.checkout_completed`, plus per-toggle audit entries.

---

## Workstream 5 — Under-21 young-driver surcharge

**Decision (Mo):** 18–20 allowed with per-day surcharge; 21+ normal.

- Settings: `minDriverAge` default → 18, new `youngDriverAge` (default 21; drivers under this pay the fee) and `youngDriverFeeCentsPerDay` (default 1000).
- Wizard: step 2 gains a compact "Main driver's age" selector: `18–20` / `21+` (labels derived from settings). Quote request carries the flag; **first quote is already honest**.
- `quote()`: new breakdown line `youngDriverCents = feePerDay × days`; flows into subtotal, deposit %, Stripe amount, emails, contract.
- Licence step: DOB validated server-side in `createBooking` — under `minDriverAge` still hard-rejects; claimed 21+ but DOB under `youngDriverAge` → server recomputes with surcharge and the review step shows a transparent price-update notice before payment (never a post-payment surprise); claimed 18–20 but actually older → surcharge dropped, price goes down.
- Snapshot: applied flag + fee live in `priceBreakdown` (DOB stays encrypted, never re-read).

---

## Workstream 6 — Fleet management upgrades

Client asks, all on the Fleet & pricing page:

- **Structured vehicle identity:** new columns `make`, `model`, `year` (int), `color` — separate fields (client ask). `name` stays for display/compat; the form composes it from make + model by default. Fleet form, list, planning-board labels, public class cards updated where relevant.
- **Grouping + search:** fleet list grouped by class in the original CLASS_ORDER (Economy, Compact, SUV, 4x4, Van) with sticky group headers; a search bar filtering on plate / make / model / name; class filter chips.
- **Per-car notes (complaints / future maintenance):** new `vehicle_notes` table (`id`, `vehicle_id` FK, `body`, `created_by`, `created_at`, `resolved_at` nullable). Notes drawer per vehicle (add, list newest-first, resolve); open-note count badge on the fleet row and on the planning-board vehicle label (tooltip). A note can be escalated to an availability block in one tap ("Block car for this").
- Compliance fields + badges live here too (workstream 3).

---

## Workstream 7 — Reports upgrade

Client asks: revenue per rental → **per car, per month, in a PDF**, and **yearly**; **borg separated from total profit**.

- **Per-car revenue matrix:** `/admin/reports` gains a per-car table (rows = vehicles grouped by class, columns = months of the selected year, cells = revenue attributed by the existing overlap-day month-slicing; row totals + yearly grand total). Year selector.
- **Borg separation:** revenue figures count **rental income only** (vehicle + insurance + extras + surcharges from snapshots). Security deposits are never revenue; a separate small "Borg" panel reports (from workstream 4 checklist data): held, returned, withheld (with amounts + reasons) for the period. Historical pre-wave `full_deposit` Stripe charges are excluded from revenue figures.
- **PDF export:** "Download PDF" on reports — monthly report (per-car breakdown for a chosen month) and yearly report (per-car × 12 matrix + totals + borg panel), rendered server-side with `@react-pdf/renderer` (same dependency as contracts), Sand & Surf styled, filename like `revenue-2026-03.pdf` / `revenue-2026.pdf`. Generated on demand via an admin API route (no storage needed).

---

## Workstream 8 — Staff logins (who did what)

Client ask: "every person a new code, and the login with which code shows who logged in."

- **Owner-managed staff accounts:** new `/admin/staff` page (owner-only): create/deactivate staff members (name + auto-generated personal **6-digit login code**, shown once, stored hashed like OTP codes). Regenerate code anytime.
- **Staff login:** the admin login screen gains a "Staff code" path — enter personal code → session bound to that staff `admin_user`. Protections: per-scope rate limiting (existing infra), lockout after 5 failed attempts (15 min), codes hashed, owner can revoke instantly. The owner keeps full password + TOTP login.
- **Who logged in:** every login writes an audit entry (`admin.login`, actor = the person); the existing audit log page therefore answers "who logged in when", and every `mutate()` action already records the actor — so check-ins, extensions, notes, etc. are attributable per person. A small "Recent logins" card on the staff page for one-glance visibility.
- **Permissions:** staff role becomes usable via per-route role opt-ins. Staff CAN: planning board, create/move bookings, check-in/check-out, extensions (desk + link), vehicle notes, view fleet. Staff CANNOT: settings, pricing edits, refunds, reports, staff management, policies, audit log (owner-only stays default). Route guards move from implicit owner-only to explicit role lists on the opted-in routes.
- Security note: a 6-digit code is deliberately weaker than the owner's password+TOTP — acceptable because staff scope excludes money movement and settings, and rate limiting + lockout + instant revocation apply. Recorded here as an accepted trade-off (desk usability).

---

## Tex Cars port (end of wave)

- Order: (1) port FD's four security fixes + Next 15.5.20 first — they protect a signed client and are independent; (2) port admin kit + admin redesign + booking wizard (whole-file copies for rewritten files per divergence map); (3) port the feature wave commits; (4) skip marketing-funnel commits (`a288900`, `f525d5a`, leads schema/migration 0014 — Tex marketing lives in the static `site/` repo). Renumber wave migrations for Tex accordingly.
- Protected during port: Tex `scripts/seed.ts` (real 34-car fleet), `seed-demo-bookings.ts`, branding strings, `env.ts` (hand-merge; Tex EMAIL_FROM/demo block), vercel.json cron schedule (Tex uses */15; add the compliance cron alongside).
- **Tex data tasks (client asks):** retire the 4 A-plate Suzukis (A-71203, A-68405, A-21141, A-67530) — status `retired`, kept for history, excluded from fleet list default view and planning board; backfill make/model/year/color for the real fleet in the seed; set Tex settings: minDriverAge 18, youngDriver fee per owner, cancellation window 48h.
- Tex-specific config: public layout brand config → tex-cars.com; contract PDF operator block = Tex Cars details; currency/fees per Tex settings.
- Gate: full Tex vitest suite green (`npm test -- --no-file-parallelism`) + manual smoke of book flow, planning board, check-in/out, extension, reports PDF in Tex branding. Tex repo gets its own commits (no shared history; git-apply from FD).

---

## Cross-cutting

- **Migrations:** every schema change is a drizzle migration on top of 0014; hand-written SQL where constraints demand it. PGlite (dev/test) + Supabase (prod) both supported by the existing runner.
- **Tests:** every workstream lands with vitest coverage beside the existing ~199 (time overlap/boundary cases, deposit math, cancellation-window logic, extension delta pricing + conflicts, alert-stage dedup, inspection lifecycle + status transitions + checklist, young-driver quote lines, storage abstraction with local driver, per-car report attribution, staff-code auth + lockout + role guards). Suite runs with `--no-file-parallelism`. Never `npm run build` while dev server runs.
- **Design language:** all new UI uses the Sand & Surf admin kit + `@/components/ui`; public wizard follows the existing step-wizard patterns. No external assets (CSP). Dash-free copy. **Less clicking** (see principle at top).
- **Audit:** every new admin mutation goes through `mutate(req, action, fn)` and gets audit-logged with the acting person (workstream 8 makes actors granular).
- **Notifications:** new bell types `booking.picked_up`, `booking.returned`, `vehicle.document_expiring`; email templates added to `templates.ts` (pure functions, unit-tested like existing).
- **New deps (minimal):** `@react-pdf/renderer` (contracts + reports), `@supabase/supabase-js` (storage driver; prod path). Everything else stack-native.

## Open details left to the implementation plan (deliberately)
A. Exact retention/cleanup wiring for inspection photos vs `licenseRetentionDays` (follow existing retention pattern).
B. Signature canvas implementation (hand-rolled pointer-events canvas, CSP-safe; no dependency unless it proves painful).
C. Contract + report PDF layout details (follow email template branding).
D. Exact bar color values for the new states (pick within Sand & Surf palette, keep legend readable).

## Explicitly deferred (do NOT build this wave)
- Hourly pricing, pricing grace period setting, seasonal pricing/coupons.
- Vehicle document scan attachments (cheap follow-up once storage exists).
- Borg money automation (cash/hold stays a physical process; we only record it).
- Multi-tenant, Stripe Connect, per-tenant keys, embeddable widget.
- Realtime bell (stays 30s polling). Staff permissions beyond the listed opt-ins.
