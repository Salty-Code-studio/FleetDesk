# Feature Wave 2026-07 — Cross-Plan Seams (canonical names)

Every plan and every implementer MUST use these exact names. If a plan needs something not listed here, it defines it locally; if two plans need it, it belongs here. Spec: `docs/superpowers/specs/2026-07-27-feature-wave-design.md`. Work happens on branch `feat/wave-2026-07`.

## Plan sequence (execution order)

| # | Plan file | Workstream |
|---|-----------|-----------|
| 01 | `2026-07-27-wave-01-time-foundation.md` | Time-aware booking (spec W1) |
| 02 | `2026-07-27-wave-02-payments-extensions.md` | Payment redesign + extensions (W2), introduces BookingDrawer |
| 03 | `2026-07-27-wave-03-compliance-alerts.md` | Insurance/inspection alerts (W3) |
| 04 | `2026-07-27-wave-04-fleet-upgrades.md` | Fleet management upgrades (W6) |
| 05 | `2026-07-27-wave-05-young-driver.md` | Under-21 surcharge (W5) |
| 06 | `2026-07-27-wave-06-checkin-checkout.md` | Storage + check-in/check-out (W4) |
| 07 | `2026-07-27-wave-07-reports.md` | Reports upgrade (W7) |
| 08 | `2026-07-27-wave-08-staff-logins.md` | Staff logins (W8) |
| 09 | `2026-07-27-wave-09-tex-port.md` | Tex Cars port + data tasks |

Later plans may rely on earlier plans being merged; never the reverse.

## Global constraints (apply to every task in every plan)

- Tests: `npm test -- --no-file-parallelism` (vitest). New features land with tests.
- NEVER `npm run build` while a `next dev` server is running (shared `.next` corrupts).
- Migrations: `npm run db:generate` for drizzle diffs; hand-written SQL files in `./drizzle` for constraints/enum surgery (precedent: 0002, 0007, 0010). Applied with `npm run db:migrate`. Must work on BOTH PGlite (`pglite://`, dev/test) and Postgres (Supabase prod).
- Admin mutations go through `mutate(req, action, fn)` from `src/lib/admin/guard.ts` (audit-logged); reads through `read(req, fn)`.
- Admin UI: reuse `Modal, Drawer, useToast, useConfirm, Skeleton, EmptyState, registerPaletteAction` from `@/app/admin/_ui` and `DatePicker, Select` from `@/components/ui`. Strict CSP: no external assets ever. Money is integer cents.
- Copy: dash-free house style (no em-dashes), warm/human tone.
- Timezone: operator-local day logic uses `America/Aruba` (existing `arubaToday()` precedent).
- Design principle: less clicking. One click from a planning bar opens the BookingDrawer with everything in it.

## Schema seams (drizzle property → SQL column)

### bookings (modified in 01, 02, 06)
- `startAt` → `start_at` timestamptz NOT NULL (was `start_date` date)
- `endAt` → `end_at` timestamptz NOT NULL (was `end_date`; `[startAt, endAt)` semantics preserved)
- `bufferEndAt` → `buffer_end_at` timestamptz NOT NULL (was `buffer_end_date`)
- `amountPaidCents` → `amount_paid_cents` integer NOT NULL default 0 (plan 02)
- status pgEnum `booking_status` gains value `'picked_up'` (added in plan 01 migration so the constraint can reference it; first written by plan 06)
- `paymentOption` pgEnum `payment_option` becomes `('deposit','full')` (plan 02 migration maps `reservation_fee`→`deposit`, `full_deposit`→`deposit`, `cash_deposit`→`deposit`)
- Exclusion constraint (plan 01, hand SQL): `bookings_no_overlap EXCLUDE USING gist (vehicle_id WITH =, tstzrange(start_at, buffer_end_at, '[)') WITH &&) WHERE (status IN ('pending','confirmed','picked_up'))`

### availability_blocks (modified in 01)
- `startAt` → `start_at` timestamptz, `endAt` → `end_at` timestamptz (existing date rows convert as local 00:00 → next-day 00:00)

### blackout_dates — UNCHANGED (stays whole-day dates)

### settings (modified in 01, 02, 03, 05)
- `turnaroundBufferHours` → `turnaround_buffer_hours` int NOT NULL default 24 (plan 01; migrate old `turnaround_buffer_days` × 24, drop old)
- `openingTime` → `opening_time` text NOT NULL default `'08:00'` (plan 01)
- `closingTime` → `closing_time` text NOT NULL default `'18:00'` (plan 01)
- `depositPercent` → `deposit_percent` int NOT NULL default 25 (plan 02)
- `depositMinCents` → `deposit_min_cents` int NOT NULL default 3000 (plan 02; rename/migrate from `reservation_fee_cents`)
- `cancellationWindowHours` → `cancellation_window_hours` int NOT NULL default 48 (plan 02)
- `complianceAlertDays` → `compliance_alert_days` int NOT NULL default 30 (plan 03)
- `minDriverAge` default changes 21 → 18 (plan 05; existing rows untouched)
- `youngDriverAge` → `young_driver_age` int NOT NULL default 21 (plan 05)
- `youngDriverFeeCentsPerDay` → `young_driver_fee_cents_per_day` int NOT NULL default 1000 (plan 05)

### vehicles (modified in 03, 04)
- `make` text, `model` text, `year` integer, `color` text — all nullable (plan 04); `name` kept (display; form composes "make model" by default)
- `insuranceExpiresOn` → `insurance_expires_on` date nullable (plan 03)
- `inspectionDueOn` → `inspection_due_on` date nullable (plan 03)
- `insuranceAlertStage` → `insurance_alert_stage` smallint NOT NULL default 0 (plan 03; 0=none, 1=30d fired, 2=7d fired, 3=overdue fired)
- `inspectionAlertStage` → `inspection_alert_stage` smallint NOT NULL default 0 (plan 03)

### vehicle_notes — NEW (plan 04)
`id` uuid PK, `vehicleId` FK→vehicles cascade, `body` text NOT NULL, `createdBy` FK→admin_users, `createdAt` timestamptz default now, `resolvedAt` timestamptz nullable.

### inspections — NEW (plan 06)
`id` uuid PK, `bookingId` FK→bookings cascade, `kind` pgEnum `inspection_kind` (`'pickup'|'return'`), `odometer` int, `fuelLevel` smallint (0–8 eighths), `notes` text default '', `photos` jsonb (`[{key: string, label: string}]`), `licensePhotoKey` text, `signatureKey` text, `contractPdfKey` text, `damageFlags` jsonb (`[{photoKey: string, note: string}]`), `acceptedPolicyVersion` int, `agreementSigned` bool default false, `rulesSigned` bool default false, `licenseCopyReceived` bool default false, `borgReceivedCents` int nullable, `borgMethod` text nullable (`'cash'|'card'`), `borgReturnedCents` int nullable, `borgWithheldCents` int nullable, `borgWithheldReason` text nullable, `keysReturned` bool default false, `createdBy` FK→admin_users, `createdAt` timestamptz. UNIQUE (bookingId, kind).

### payments (modified in 02)
- `method` pgEnum `payment_method` (`'stripe'|'desk'`) NOT NULL default `'stripe'`
- type pgEnum `payment_type` gains `'extension'`
- `'refunded'` status finally gets writers (refund flows)

### admin_users (modified in 08)
- `loginCodeHash` → `login_code_hash` text nullable (sha256, same pattern as `login_tokens.codeHash`)
- `codeFailedAttempts` → `code_failed_attempts` smallint NOT NULL default 0
- `codeLockedUntil` → `code_locked_until` timestamptz nullable
- `active` boolean NOT NULL default true

## Function/API seams

### Time & validation (plan 01)
- `src/lib/validation/iso-date.ts` gains `isoDateTime` zod schema (ISO 8601 with offset, e.g. `2026-08-01T09:00:00-04:00`); `isoDate` stays.
- `src/lib/time/format.ts` NEW: `formatDateTime(iso: string): string` ("Aug 1, 2026 at 09:00", Aruba TZ), `formatTimeRangeDay(...)` helpers; ALL user-facing period rendering (emails, wizard, admin, contract) goes through this file.
- `checkAvailability(vehicleId: string, startAt: string, endAt: string, opts: { turnaroundBufferHours: number })` in `src/lib/booking/availability.ts` (ISO datetime strings).
- `validateDates(startAt, endAt, settings)` same file: whole-day min/max from timestamps, business-hours + 30-min-step check, past check.
- `rentalDays(startAt: string, endAt: string): number` in `src/lib/booking/quote.ts` = `Math.max(1, Math.ceil(hours / 24))`.
- Public APIs (`/api/quote`, `/api/classes`, `/api/availability`, `/api/bookings`) accept datetime OR date-only (date-only defaults to `settings.openingTime`).
- `src/components/ui/TimeSelect.tsx` NEW: `value: "HH:MM"`, `onChange`, `min`, `max`, 30-min steps; exported from `@/components/ui`.

### Payments (plan 02)
- `paymentAmounts(breakdown: QuoteBreakdown, option: 'deposit'|'full', settings): { payNowCents: number, balanceDueCents: number }` in `src/lib/payments/charge.ts`. Deposit = `max(round(subtotal × depositPercent/100), depositMinCents)`, capped at subtotal.
- QuoteBreakdown (in `src/lib/booking/quote.ts`) gains `youngDriverCents: number` (0 until plan 05 wires it).
- `extendBooking(bookingId, { endAt, payment: 'link'|'desk', actor })` in `src/lib/admin/extend-booking.ts` NEW; route `POST /api/admin/bookings/[id]/extend`; delta = `max(0, newQuote.subtotalCents − oldSnapshot.subtotalCents)`.
- `refundPayment(paymentId, { amountCents?, actor })` in `src/lib/payments/refunds.ts` NEW; route `POST /api/admin/payments/[id]/refund`; audit `admin.payment_refunded`.
- Cancellation eligibility: `isFreeCancellation(booking, settings, now)` in `src/lib/booking/cancellation.ts` NEW (now ≤ startAt − cancellationWindowHours).
- `BookingDrawer` NEW component `src/app/admin/(shell)/booking-drawer.tsx`: opened on planning-bar click; sections: summary, payments (plan 02), checklist + inspections (plan 06 adds), actions (Move, Cancel, Extend, Check in/out). Replaces the old BookingPanel popover as the primary surface.
- Public brand config: `src/lib/site-config.ts` NEW — `siteName`, `siteUrl`, `backLinkLabel` read from env (`NEXT_PUBLIC_SITE_NAME`, `NEXT_PUBLIC_SITE_URL`); public layout + emails use it (Tex port = env change).

### Storage (plan 06, shared infra)
- `src/lib/storage/index.ts`: `putObject(key: string, data: Uint8Array, contentType: string): Promise<void>`, `getSignedUrl(key: string, ttlSeconds: number): Promise<string>`, `deleteObject(key: string): Promise<void>`. Drivers `src/lib/storage/supabase.ts`, `src/lib/storage/local.ts` picked by `env.STORAGE_DRIVER` (`'supabase'|'local'`, default `'local'`).
- Env (add to `src/env.ts`): `STORAGE_DRIVER`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `STORAGE_BUCKET` (default `fleet-docs`), `LOCAL_STORAGE_DIR` (default `.dev-storage`).
- Upload route: `POST /api/admin/uploads` (multipart field `file`, optional `label`) → `{ key: string }`. Key format: `inspections/{bookingId}/{kind}/{uuid}.jpg`, `licenses/{bookingId}/{uuid}.jpg`, `contracts/{bookingId}.pdf`, `signatures/{bookingId}.png`.

### PDF (plans 06, 07)
- `src/lib/pdf/contract.tsx`: `renderContractPdf(data: ContractData): Promise<Uint8Array>` (`@react-pdf/renderer`).
- `src/lib/pdf/report.tsx`: `renderRevenueReportPdf(data: RevenueReportData): Promise<Uint8Array>`.
- Plan 06 adds the dependency + contract; plan 07 reuses the dependency.

### Inspections (plan 06)
- `PUT /api/admin/bookings/[id]/inspection/[kind]` upsert draft fields; `POST /api/admin/bookings/[id]/inspection/[kind]/complete` finalizes (pickup: → status `picked_up`, contract PDF + email; return: → `completed`).
- Lib `src/lib/admin/inspections.ts`: `upsertInspection(...)`, `completePickup(...)`, `completeReturn(...)`.
- Bell types: `booking.picked_up`, `booking.returned` (warning when damage flagged).

### Compliance (plan 03)
- Cron route `GET /api/cron/compliance-alerts` (bearer `CRON_SECRET`, vercel.json daily `0 9 * * *` UTC ≈ 05:00 Aruba).
- `src/lib/admin/compliance.ts`: `runComplianceAlerts(now?: Date): Promise<{fired: number}>` — stages 1=first warning (`complianceAlertDays`), 2=7d, 3=overdue; fires bell `vehicle.document_expiring` + `alertOwner` with `adminDocumentExpiringEmail` (new template in `src/lib/email/templates.ts`).
- Dashboard compliance card: `GET /api/admin/compliance` → `{ items: [{vehicleId, name, plate, kind: 'insurance'|'inspection', dueOn, daysLeft}] }`.

### Quote/young driver (plan 05)
- Quote request bodies gain optional `youngDriver: boolean` (public flag from the age selector); `quote()` signature gains it; breakdown line `youngDriverCents`.
- `createBooking` recomputes from DOB truth; mismatch → booking is created with corrected snapshot and the API response includes `priceAdjusted: true` for the UI notice.

### Reports (plan 07)
- `GET /api/admin/reports/per-car?year=YYYY` → `{ year, months: string[], rows: [{vehicleId, name, plate, class, monthCents: number[], totalCents}], grandTotalCents, borg: { heldCents, returnedCents, withheldCents, withheldCount } }` (lib `src/lib/admin/reports.ts` extended: `perCarRevenue(year)`).
- `GET /api/admin/reports/pdf?year=YYYY[&month=M]` → `application/pdf`.

### Staff auth (plan 08)
- `POST /api/admin/auth/staff-login` body `{ code: string }` (rate-limited `auth` tier; 5 fails → 15 min lock).
- Staff CRUD: `GET/POST /api/admin/staff`, `POST /api/admin/staff/[id]/regenerate`, `PATCH /api/admin/staff/[id]` (`{active}`); owner-only.
- Guard: `read`/`mutate` accept `{ roles: ('owner'|'staff')[] }`; default stays `['owner']`. Staff opt-in routes: planning, bookings create/move/extend(desk+link), inspection routes, uploads, vehicle notes, fleet read, compliance read. Audit action `admin.login` written on every successful login (both paths).

## Notification/email seams (new items only)
- Bell types: `booking.picked_up`, `booking.returned`, `booking.extended`, `vehicle.document_expiring`.
- Templates (all in `src/lib/email/templates.ts`, pure `{subject, html}`): `adminDocumentExpiringEmail`, `bookingPickedUpEmail` (contract link/attachment), `bookingReturnSummaryEmail`, `bookingExtendedEmail`; existing `bookingCancelledEmail` gains a refund line variant param.

## New dependencies (the ONLY new deps allowed)
- `@react-pdf/renderer` (plan 06 introduces)
- `@supabase/supabase-js` (plan 06 introduces)
