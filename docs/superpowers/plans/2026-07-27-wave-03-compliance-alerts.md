# Compliance Alerts (Insurance + Inspection) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track per-vehicle insurance expiry and yearly inspection dates, fire staged owner alerts (first warning, one week, overdue) exactly once per stage via a daily cron, and surface the same information as fleet badges and a dashboard card.

**Architecture:** Four new nullable/defaulted columns on `vehicles` plus one `settings` column carry the state; a pure staging function in `src/lib/admin/compliance.ts` computes the target alert stage from the date alone and fires (bell + owner email + WhatsApp) only when the target exceeds the recorded stage, so each stage alerts exactly once. Editing the date in the Fleet form resets the recorded stage to 0, which restarts the cycle for next year's inspection. A Vercel cron route (bearer `CRON_SECRET`, copied from the existing expire-holds pattern) runs the check daily; a small admin read API feeds the dashboard card.

**Tech Stack:** Next.js 15 App Router route handlers, Drizzle ORM (PGlite dev/test, Supabase Postgres prod), zod at every boundary, vitest, existing Sand & Surf admin kit (`Modal, Drawer, useToast, Skeleton, EmptyState` from `@/app/admin/_ui`; `DatePicker, Select` from `@/components/ui`), Resend email via the existing `alertOwner()` dispatcher.

## Global Constraints

- Tests: `npm test -- --no-file-parallelism` (vitest). New features land with tests.
- NEVER `npm run build` while a `next dev` server is running (shared `.next` corrupts).
- Migrations: `npm run db:generate` for drizzle diffs; hand-written SQL files in `./drizzle` for constraints/enum surgery (precedent: 0002, 0007, 0010). Applied with `npm run db:migrate`. Must work on BOTH PGlite (`pglite://`, dev/test) and Postgres (Supabase prod).
- Admin mutations go through `mutate(req, action, fn)` from `src/lib/admin/guard.ts` (audit-logged); reads through `read(req, fn)`.
- Admin UI: reuse `Modal, Drawer, useToast, useConfirm, Skeleton, EmptyState, registerPaletteAction` from `@/app/admin/_ui` and `DatePicker, Select` from `@/components/ui`. Strict CSP: no external assets ever. Money is integer cents.
- Copy: dash-free house style (no em-dashes), warm/human tone.
- Timezone: operator-local day logic uses `America/Aruba` (existing `arubaToday()` precedent).
- Design principle: less clicking. One click from a planning bar opens the BookingDrawer with everything in it.
- Workstream 3 specifics: the alert ladder is `complianceAlertDays` (configurable, default 30) then a fixed 7-day warning then overdue; only the first threshold is a setting. Alerts are best-effort and must never throw (both `notifyAdmin()` and `alertOwner()` already guarantee this). No document scan attachments this wave. `blackout_dates` and booking tables are untouched by this plan.
- Sequencing note: this plan executes after plans 01 and 02 are merged. Those plans change bookings/settings/planning-board internals; nothing in this plan depends on those changes, but exact line numbers quoted below are from the pre-wave codebase, so treat them as anchors ("the block that looks like this") rather than gospel. All quoted code blocks exist verbatim unless plans 01/02 restyled them; match on content.

---

### Task 1: Schema columns + migration (vehicles compliance fields, settings.complianceAlertDays)

**Files:**
- Modify: `src/lib/db/schema/fleet.ts` (vehicles table, currently lines 8-26)
- Modify: `src/lib/db/schema/settings.ts` (settings table, currently lines 9-21)
- Create: one drizzle-generated migration in `./drizzle` (via `npm run db:generate`; do NOT hardcode a number, other plans also add migrations)
- Test: `src/test/compliance-alerts.test.ts` (new file; later tasks append to it)

**Interfaces:**
- Consumes: `getDb()` from `@/lib/db/client`; `runMigrations()` from `@/lib/db/migrate` (applies everything in `./drizzle` to the test PGlite); `getSettings(): Promise<Settings>` from `@/lib/admin/settings` (returns the singleton row, self-heals if missing).
- Produces (seam names, used by every later task and by plan 09's Tex port):
  - `vehicles.insuranceExpiresOn` -> `insurance_expires_on` date nullable
  - `vehicles.inspectionDueOn` -> `inspection_due_on` date nullable
  - `vehicles.insuranceAlertStage` -> `insurance_alert_stage` smallint NOT NULL default 0 (0=none, 1=30d fired, 2=7d fired, 3=overdue fired)
  - `vehicles.inspectionAlertStage` -> `inspection_alert_stage` smallint NOT NULL default 0
  - `settings.complianceAlertDays` -> `compliance_alert_days` int NOT NULL default 30

**Steps:**

- [ ] Write the failing test. Create `src/test/compliance-alerts.test.ts` with exactly:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
});

describe("compliance schema", () => {
  it("vehicles carry expiry dates and alert stages defaulting to 0", async () => {
    const [v] = await db.insert(vehicles).values({
      slug: "comp-schema-car", plate: "PL-COMP-1", class: "SUV", name: "Comp Car", seats: 5,
      transmission: "Automatic", doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
      insuranceExpiresOn: "2027-03-01", inspectionDueOn: "2027-06-15",
    }).returning();
    expect(v!.insuranceExpiresOn).toBe("2027-03-01");
    expect(v!.inspectionDueOn).toBe("2027-06-15");
    expect(v!.insuranceAlertStage).toBe(0);
    expect(v!.inspectionAlertStage).toBe(0);
  });

  it("a vehicle with no tracked dates stores nulls", async () => {
    const [v] = await db.insert(vehicles).values({
      slug: "comp-schema-bare", plate: "PL-COMP-0", class: "Economy", name: "Bare Car", seats: 4,
      transmission: "Manual", doors: 4, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
    }).returning();
    expect(v!.insuranceExpiresOn).toBeNull();
    expect(v!.inspectionDueOn).toBeNull();
  });

  it("settings expose complianceAlertDays defaulting to 30", async () => {
    const s = await getSettings();
    expect(s.complianceAlertDays).toBe(30);
  });
});
```

- [ ] Run the test to verify it fails: `npm test -- --no-file-parallelism src/test/compliance-alerts.test.ts`. Expected failure: `expected undefined to be '2027-03-01'` (the unknown insert keys are stripped at runtime and the returned row has no such properties), and the settings test fails with `expected undefined to be 30`.

- [ ] Edit `src/lib/db/schema/fleet.ts`. Change the import line (line 1)

```ts
import { pgTable, pgEnum, text, integer, boolean, timestamp, date, uuid, jsonb, check } from "drizzle-orm/pg-core";
```

to

```ts
import { pgTable, pgEnum, text, integer, boolean, timestamp, date, uuid, jsonb, check, smallint } from "drizzle-orm/pg-core";
```

and inside the `vehicles` table, directly after the line `status: vehicleStatus("status").notNull().default("active"),` (line 23), insert:

```ts
  // Compliance (wave 03): document expiry dates + alert-stage dedup markers.
  // Stage: 0=none fired, 1=first warning fired (settings.complianceAlertDays out),
  // 2=one-week warning fired, 3=overdue fired. Editing a date resets its stage.
  insuranceExpiresOn: date("insurance_expires_on"),
  inspectionDueOn: date("inspection_due_on"),
  insuranceAlertStage: smallint("insurance_alert_stage").notNull().default(0),
  inspectionAlertStage: smallint("inspection_alert_stage").notNull().default(0),
```

- [ ] Edit `src/lib/db/schema/settings.ts`. Inside the `settings` table, directly after the line `adminAlertRecipients: jsonb("admin_alert_recipients").$type<string[]>().notNull().default(sql`'[]'::jsonb`),` (line 19), insert:

```ts
  // Days before a vehicle document expiry at which the FIRST compliance warning
  // fires (wave 03). The one-week and overdue stages are fixed.
  complianceAlertDays: integer("compliance_alert_days").notNull().default(30),
```

- [ ] Generate the migration: run `npm run db:generate` from the repo root. drizzle-kit writes a new numbered SQL file in `./drizzle` (random name suffix, e.g. `00NN_something.sql`), a snapshot in `./drizzle/meta`, and appends a journal entry, all automatically. Open the generated SQL file and verify it contains exactly these five statements (order may vary):

```sql
ALTER TABLE "settings" ADD COLUMN "compliance_alert_days" integer DEFAULT 30 NOT NULL;
ALTER TABLE "vehicles" ADD COLUMN "insurance_expires_on" date;
ALTER TABLE "vehicles" ADD COLUMN "inspection_due_on" date;
ALTER TABLE "vehicles" ADD COLUMN "insurance_alert_stage" smallint DEFAULT 0 NOT NULL;
ALTER TABLE "vehicles" ADD COLUMN "inspection_alert_stage" smallint DEFAULT 0 NOT NULL;
```

If the file contains anything else (e.g. drift from another table), STOP and re-check that your working tree includes all previously merged wave migrations before regenerating.

- [ ] Run the test to verify it passes: `npm test -- --no-file-parallelism src/test/compliance-alerts.test.ts`. Expected: 3 passing (tests apply `./drizzle` via `runMigrations()`, no `db:migrate` needed for the test database).

- [ ] Run the full suite to catch regressions: `npm test -- --no-file-parallelism`. Expected: all green.

- [ ] Commit:

```bash
git add src/lib/db/schema/fleet.ts src/lib/db/schema/settings.ts drizzle src/test/compliance-alerts.test.ts
git commit -m "feat(compliance): vehicle expiry dates, alert stages, complianceAlertDays setting"
```

---

### Task 2: Boundary validation + stage-reset-on-date-change dedup

**Files:**
- Modify: `src/lib/admin/vehicles.ts` (`VehicleCreateSchema` lines 12-27, `updateVehicle` lines 57-67)
- Modify: `src/lib/admin/settings.ts` (`SettingsPatchSchema` lines 13-26)
- Test: `src/test/compliance-alerts.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's columns; `isoDate` zod schema from `@/lib/validation/iso-date` (a strict real-calendar-date `YYYY-MM-DD` string schema, already imported at the top of `src/lib/admin/vehicles.ts` and `src/lib/admin/settings.ts`); `createVehicle(input)`, `updateVehicle(id, patch)`, `VehicleCreateSchema`, `VehiclePatchSchema` (already exported from `src/lib/admin/vehicles.ts`; the admin routes `POST/PATCH /api/admin/vehicles[...]` already parse these schemas via `parseJsonBody`, so no route file changes are needed); `patchSettings(patch)` and `SettingsPatchSchema` from `src/lib/admin/settings.ts` (the `PATCH /api/admin/settings` route already parses this schema).
- Produces:
  - `VehicleCreateSchema` (and therefore `VehiclePatchSchema = VehicleCreateSchema.partial()`) accepts optional nullable `insuranceExpiresOn` and `inspectionDueOn` as `YYYY-MM-DD` strings.
  - `updateVehicle` resets `insuranceAlertStage` to 0 whenever `insuranceExpiresOn` changes value, and `inspectionAlertStage` to 0 whenever `inspectionDueOn` changes value (the stage-reset dedup the cron relies on; this is how "enter next year's inspection date" restarts the alert cycle).
  - `SettingsPatchSchema` accepts optional `complianceAlertDays` (int, 1-365).

**Steps:**

- [ ] Write the failing tests. Append to `src/test/compliance-alerts.test.ts`. Add these imports at the top of the file (merge into the existing import block):

```ts
import { eq } from "drizzle-orm";
import {
  createVehicle, updateVehicle, VehicleCreateSchema, VehiclePatchSchema,
} from "@/lib/admin/vehicles";
import { patchSettings, SettingsPatchSchema } from "@/lib/admin/settings";
```

Then append this describe block at the end of the file:

```ts
describe("compliance fields at the vehicle API boundary", () => {
  it("accepts and persists expiry dates through create", async () => {
    const input = VehicleCreateSchema.parse({
      slug: "comp-val-car", plate: "PL-COMP-2", class: "Economy", name: "Val Car", seats: 4,
      transmission: "Manual", doors: 4, priceDayCents: 1000, priceWeekCents: 6000, priceMonthCents: 20000,
      insuranceExpiresOn: "2027-05-01",
    });
    const v = await createVehicle(input);
    expect(v.insuranceExpiresOn).toBe("2027-05-01");
    expect(v.inspectionDueOn).toBeNull();
  });

  it("rejects an impossible calendar date", () => {
    expect(VehiclePatchSchema.safeParse({ insuranceExpiresOn: "2027-02-30" }).success).toBe(false);
    expect(VehiclePatchSchema.safeParse({ inspectionDueOn: "not-a-date" }).success).toBe(false);
  });

  it("changing a date resets ONLY that document's alert stage", async () => {
    const [v] = await db.insert(vehicles).values({
      slug: "comp-reset-car", plate: "PL-COMP-3", class: "SUV", name: "Reset Car", seats: 5,
      transmission: "Automatic", doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
      insuranceExpiresOn: "2027-01-01", inspectionDueOn: "2027-02-01",
    }).returning();
    await db.update(vehicles)
      .set({ insuranceAlertStage: 2, inspectionAlertStage: 2 })
      .where(eq(vehicles.id, v!.id));

    const after = await updateVehicle(v!.id, { insuranceExpiresOn: "2028-01-01" });
    expect(after.insuranceAlertStage).toBe(0);   // reset: the date changed
    expect(after.inspectionAlertStage).toBe(2);  // untouched: its date did not change
  });

  it("an unrelated patch leaves both stages alone", async () => {
    const input = VehicleCreateSchema.parse({
      slug: "comp-noreset-car", plate: "PL-COMP-4", class: "Van", name: "NoReset Car", seats: 7,
      transmission: "Automatic", doors: 5, priceDayCents: 1000, priceWeekCents: 6000, priceMonthCents: 20000,
      insuranceExpiresOn: "2027-04-01",
    });
    const v = await createVehicle(input);
    await db.update(vehicles).set({ insuranceAlertStage: 1 }).where(eq(vehicles.id, v.id));
    const after = await updateVehicle(v.id, { name: "NoReset Car Renamed" });
    expect(after.insuranceAlertStage).toBe(1);
  });

  it("re-sending the SAME date does not reset the stage", async () => {
    const [row] = await db.select().from(vehicles).where(eq(vehicles.slug, "comp-noreset-car"));
    const after = await updateVehicle(row!.id, { insuranceExpiresOn: "2027-04-01" });
    expect(after.insuranceAlertStage).toBe(1);
  });

  it("settings accept complianceAlertDays within 1..365", async () => {
    expect(SettingsPatchSchema.safeParse({ complianceAlertDays: 0 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ complianceAlertDays: 366 }).success).toBe(false);
    const s = await patchSettings({ complianceAlertDays: 45 });
    expect(s.complianceAlertDays).toBe(45);
    await patchSettings({ complianceAlertDays: 30 }); // restore the default for later tests
  });
});
```

- [ ] Run the test to verify it fails: `npm test -- --no-file-parallelism src/test/compliance-alerts.test.ts`. Expected failures: `VehicleCreateSchema.parse` throws `Unrecognized key(s) in object: 'insuranceExpiresOn'` (the schema is `.strict()`), the stage-reset test gets `expected 2 to be 0`, and `SettingsPatchSchema.safeParse({ complianceAlertDays: 0 }).success` is `false` for the wrong reason (unrecognized key) while `patchSettings({ complianceAlertDays: 45 })` returns a row without the change applied by validation intent; the suite is red.

- [ ] Edit `src/lib/admin/vehicles.ts`. In `VehicleCreateSchema`, directly after the line `depositCents: optionalCentsField,` (line 25), insert:

```ts
  // Compliance (wave 03): document expiry dates. Null or absent = not tracked.
  insuranceExpiresOn: isoDate.nullable().optional(),
  inspectionDueOn: isoDate.nullable().optional(),
```

- [ ] Still in `src/lib/admin/vehicles.ts`, replace the body of `updateVehicle` (lines 57-67), which currently reads:

```ts
export async function updateVehicle(id: string, patch: z.infer<typeof VehiclePatchSchema>): Promise<Vehicle> {
  const db = await getDb();
  const current = await getVehicle(id);
  if (!current) throw Errors.notFound("Vehicle not found");
  if (patch.slug && patch.slug !== current.slug) {
    const clash = await db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.slug, patch.slug));
    if (clash.length > 0) throw Errors.conflict("A vehicle with that slug already exists");
  }
  const [row] = await db.update(vehicles).set({ ...patch, updatedAt: new Date() }).where(eq(vehicles.id, id)).returning();
  return row!;
}
```

with:

```ts
export async function updateVehicle(id: string, patch: z.infer<typeof VehiclePatchSchema>): Promise<Vehicle> {
  const db = await getDb();
  const current = await getVehicle(id);
  if (!current) throw Errors.notFound("Vehicle not found");
  if (patch.slug && patch.slug !== current.slug) {
    const clash = await db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.slug, patch.slug));
    if (clash.length > 0) throw Errors.conflict("A vehicle with that slug already exists");
  }
  // Compliance dedup (wave 03): a CHANGED document date restarts its alert
  // ladder, so entering next year's inspection date re-arms the reminders.
  const stageResets: { insuranceAlertStage?: number; inspectionAlertStage?: number } = {};
  if (patch.insuranceExpiresOn !== undefined && patch.insuranceExpiresOn !== current.insuranceExpiresOn) {
    stageResets.insuranceAlertStage = 0;
  }
  if (patch.inspectionDueOn !== undefined && patch.inspectionDueOn !== current.inspectionDueOn) {
    stageResets.inspectionAlertStage = 0;
  }
  const [row] = await db.update(vehicles).set({ ...patch, ...stageResets, updatedAt: new Date() }).where(eq(vehicles.id, id)).returning();
  return row!;
}
```

- [ ] Edit `src/lib/admin/settings.ts`. In `SettingsPatchSchema`, directly after the line `adminAlertRecipients: z.array(z.string().trim().toLowerCase().email()).max(20).optional(),` (line 22), insert:

```ts
  complianceAlertDays: z.number().int().min(1).max(365).optional(),
```

- [ ] Run the test to verify it passes: `npm test -- --no-file-parallelism src/test/compliance-alerts.test.ts`. Expected: all tests in the file green.

- [ ] Typecheck: `npx tsc --noEmit`. Expected: no errors.

- [ ] Commit:

```bash
git add src/lib/admin/vehicles.ts src/lib/admin/settings.ts src/test/compliance-alerts.test.ts
git commit -m "feat(compliance): expiry dates at the vehicle boundary + stage reset on date change"
```

---

### Task 3: `adminDocumentExpiringEmail` template

**Files:**
- Modify: `src/lib/email/templates.ts` (append a new exported function; file currently ends at line 79 with `adminPaymentEmail`)
- Test: `src/test/email-templates.test.ts` (extend)

**Interfaces:**
- Consumes: the file-local helpers already in `src/lib/email/templates.ts`: `shell(title: string, body: string): string` (brand wrapper) and the `RenderedEmail` interface `{ subject: string; html: string }`. Templates are pure functions, no I/O.
- Produces (seam name, consumed by Task 4): `adminDocumentExpiringEmail(args: { vehicleName: string; plate: string; kind: "insurance" | "inspection"; dueOn: string; daysLeft: number }): RenderedEmail`. `dueOn` is `YYYY-MM-DD`; `daysLeft` may be negative (overdue).

**Steps:**

- [ ] Write the failing test. Edit `src/test/email-templates.test.ts`:
  1. Add `adminDocumentExpiringEmail` to the import list from `@/lib/email/templates` (line 2-4).
  2. Append two entries to the `all` array (after the `adminPaymentEmail(...)` entry, line 11) so the dash-free rule covers the new template:

```ts
  adminDocumentExpiringEmail({ vehicleName: "Hyundai Creta", plate: "A-9876", kind: "insurance", dueOn: "2026-08-20", daysLeft: 7 }),
  adminDocumentExpiringEmail({ vehicleName: "Hyundai Creta", plate: "A-9876", kind: "inspection", dueOn: "2026-06-01", daysLeft: -3 }),
```

  3. Append this test inside the existing `describe("email templates", ...)` block:

```ts
  it("document expiring email states the document, the car, and the timing", () => {
    const soon = adminDocumentExpiringEmail({ vehicleName: "Kia Picanto", plate: "A-1234", kind: "insurance", dueOn: "2026-08-20", daysLeft: 24 });
    expect(soon.subject).toContain("Insurance due soon");
    expect(soon.subject).toContain("A-1234");
    expect(soon.html).toContain("24 days");
    expect(soon.html).toContain("2026-08-20");

    const today = adminDocumentExpiringEmail({ vehicleName: "Kia Picanto", plate: "A-1234", kind: "inspection", dueOn: "2026-07-27", daysLeft: 0 });
    expect(today.html).toContain("due today");

    const over = adminDocumentExpiringEmail({ vehicleName: "Kia Picanto", plate: "A-1234", kind: "inspection", dueOn: "2026-07-01", daysLeft: -5 });
    expect(over.subject).toContain("Inspection overdue");
    expect(over.html).toContain("overdue");
  });
```

- [ ] Run the test to verify it fails: `npm test -- --no-file-parallelism src/test/email-templates.test.ts`. Expected failure: `SyntaxError` / vitest import error, `adminDocumentExpiringEmail` is not exported from `@/lib/email/templates`.

- [ ] Write the implementation. Append to `src/lib/email/templates.ts` (after `adminPaymentEmail`, end of file):

```ts
export function adminDocumentExpiringEmail(args: {
  vehicleName: string; plate: string; kind: "insurance" | "inspection"; dueOn: string; daysLeft: number;
}): RenderedEmail {
  const doc = args.kind === "insurance" ? "Insurance" : "Inspection";
  const overdue = args.daysLeft < 0;
  const when = overdue
    ? `was due on ${args.dueOn} and is now overdue`
    : args.daysLeft === 0
      ? `is due today (${args.dueOn})`
      : `is due in ${args.daysLeft} ${args.daysLeft === 1 ? "day" : "days"} (${args.dueOn})`;
  return {
    subject: overdue
      ? `${doc} overdue: ${args.vehicleName} (${args.plate})`
      : `${doc} due soon: ${args.vehicleName} (${args.plate})`,
    html: shell(overdue ? `${doc} overdue` : `${doc} due soon`, `
      <p>The ${doc.toLowerCase()} for <strong>${args.vehicleName}</strong> (${args.plate}) ${when}.</p>
      <p>Once it is renewed, enter the new date in Fleet and the reminders reset for the next cycle.</p>`),
  };
}
```

- [ ] Run the test to verify it passes: `npm test -- --no-file-parallelism src/test/email-templates.test.ts`. Expected: all green, including the em-dash rule over the two new `all` entries.

- [ ] Commit:

```bash
git add src/lib/email/templates.ts src/test/email-templates.test.ts
git commit -m "feat(compliance): adminDocumentExpiringEmail template"
```

---

### Task 4: `runComplianceAlerts` + `complianceOverview` library

**Files:**
- Create: `src/lib/admin/compliance.ts`
- Test: `src/test/compliance-alerts.test.ts` (append)

**Interfaces:**
- Consumes:
  - Task 1 columns on `vehicles` (`insuranceExpiresOn`, `inspectionDueOn`, `insuranceAlertStage`, `inspectionAlertStage`, plus existing `id`, `name`, `plate`, `status`) and `settings.complianceAlertDays`.
  - `getSettings(): Promise<Settings>` from `@/lib/admin/settings`.
  - `notifyAdmin(n: { level?: "info" | "success" | "warning" | "critical"; type: string; title: string; body?: string; bookingId?: string | null }): Promise<void>` from `@/lib/notify` (durable bell row; never throws).
  - `alertOwner(a: { type: string; subject: string; html: string; whatsappText?: string }): Promise<void>` from `@/lib/notify` (emails `settings.adminAlertRecipients` via Resend, pushes WhatsApp automatically when the `WHATSAPP_*` env is configured; never throws).
  - `adminDocumentExpiringEmail(args: { vehicleName; plate; kind; dueOn; daysLeft }): { subject: string; html: string }` from `@/lib/email/templates` (Task 3).
- Produces (seam names, consumed by Tasks 5 and 6):
  - `runComplianceAlerts(now?: Date): Promise<{ fired: number }>` in `src/lib/admin/compliance.ts`. Stages: 1 = first warning (`complianceAlertDays` out), 2 = 7 days, 3 = overdue. Fires bell type `vehicle.document_expiring` (level `warning`, or `critical` when overdue) + owner email + WhatsApp, only when the computed target stage exceeds the recorded stage.
  - `complianceOverview(now?: Date): Promise<{ items: ComplianceItem[] }>` where `ComplianceItem = { vehicleId: string; name: string; plate: string; kind: "insurance" | "inspection"; dueOn: string; daysLeft: number }`, sorted by `daysLeft` ascending, listing every non-retired vehicle document due within `complianceAlertDays` or overdue.
  - Exported pure helpers `daysUntil(today: string, dueOn: string): number` and `targetStage(daysLeft: number, firstWarningDays: number): number` (unit-tested directly).

**Steps:**

- [ ] Write the failing tests. Append to `src/test/compliance-alerts.test.ts`. Add these imports at the top of the file (merge into the existing import block):

```ts
import { listNotifications } from "@/lib/admin/notifications-feed";
import { runComplianceAlerts, complianceOverview, daysUntil, targetStage } from "@/lib/admin/compliance";
```

Then append at the end of the file:

```ts
describe("compliance staging math", () => {
  it("daysUntil counts whole calendar days, negative when past", () => {
    expect(daysUntil("2027-06-01", "2027-06-21")).toBe(20);
    expect(daysUntil("2027-06-01", "2027-06-01")).toBe(0);
    expect(daysUntil("2027-06-01", "2027-05-30")).toBe(-2);
  });

  it("targetStage ladders first-warning, one-week, overdue", () => {
    expect(targetStage(31, 30)).toBe(0);
    expect(targetStage(30, 30)).toBe(1);
    expect(targetStage(8, 30)).toBe(1);
    expect(targetStage(7, 30)).toBe(2);
    expect(targetStage(1, 30)).toBe(2);
    expect(targetStage(0, 30)).toBe(2);
    expect(targetStage(-1, 30)).toBe(3);
  });
});

describe("runComplianceAlerts", () => {
  // Fixed clocks: noon Aruba time (UTC-4) so the local calendar date is unambiguous.
  const NOW_20D = new Date("2027-06-01T12:00:00-04:00"); // 20 days before 2027-06-21
  const NOW_5D = new Date("2027-06-16T12:00:00-04:00");  // 5 days before
  const NOW_OVER = new Date("2027-06-23T12:00:00-04:00"); // 2 days past

  let cronCarId = "";
  const PLATE = "PL-CRON-1";
  const mine = async () =>
    (await listNotifications(200)).notifications.filter((n) => n.title.includes(PLATE));

  beforeAll(async () => {
    await patchSettings({ complianceAlertDays: 30 }); // pin the threshold for determinism
    const [v] = await db.insert(vehicles).values({
      slug: "comp-cron-car", plate: PLATE, class: "SUV", name: "Cron Car", seats: 5,
      transmission: "Automatic", doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
      insuranceExpiresOn: "2027-06-21",
    }).returning();
    cronCarId = v!.id;
  });

  it("fires the first warning once, with a warning-level bell", async () => {
    const r = await runComplianceAlerts(NOW_20D);
    expect(r.fired).toBeGreaterThanOrEqual(1); // other seeded cars may fire too
    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, cronCarId));
    expect(row!.insuranceAlertStage).toBe(1);
    const notes = await mine();
    expect(notes.length).toBe(1);
    expect(notes[0]!.type).toBe("vehicle.document_expiring");
    expect(notes[0]!.level).toBe("warning");
    expect(notes[0]!.title).toContain("Insurance due soon");
  });

  it("is idempotent for the same day (stage dedup)", async () => {
    const r = await runComplianceAlerts(NOW_20D);
    expect(r.fired).toBe(0); // every vehicle's stage is already caught up
    expect((await mine()).length).toBe(1);
  });

  it("escalates to the one-week stage exactly once", async () => {
    await runComplianceAlerts(NOW_5D);
    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, cronCarId));
    expect(row!.insuranceAlertStage).toBe(2);
    expect((await mine()).length).toBe(2);
    expect((await runComplianceAlerts(NOW_5D)).fired).toBe(0);
  });

  it("escalates to overdue with a critical bell", async () => {
    await runComplianceAlerts(NOW_OVER);
    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, cronCarId));
    expect(row!.insuranceAlertStage).toBe(3);
    const notes = await mine();
    expect(notes.length).toBe(3);
    expect(notes[0]!.level).toBe("critical"); // newest first
    expect(notes[0]!.title).toContain("Insurance overdue");
  });

  it("a new future date (entered via updateVehicle) re-arms the ladder", async () => {
    await updateVehicle(cronCarId, { insuranceExpiresOn: "2028-06-21" });
    expect((await runComplianceAlerts(NOW_OVER)).fired).toBe(0); // far future: nothing to fire
    await runComplianceAlerts(new Date("2028-06-05T12:00:00-04:00")); // 16 days out next year
    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, cronCarId));
    expect(row!.insuranceAlertStage).toBe(1);
    expect((await mine()).length).toBe(4);
  });

  it("skips untracked documents and retired vehicles entirely", async () => {
    await db.insert(vehicles).values({
      slug: "comp-cron-retired", plate: "PL-CRON-RET", class: "Van", name: "Retired Car", seats: 7,
      transmission: "Manual", doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
      status: "retired", insuranceExpiresOn: "2027-01-01",
    });
    await runComplianceAlerts(NOW_OVER);
    const notes = (await listNotifications(200)).notifications;
    expect(notes.some((n) => n.title.includes("PL-CRON-RET"))).toBe(false);
    expect(notes.some((n) => n.title.includes("PL-COMP-0"))).toBe(false); // the no-dates car from Task 1
  });

  it("self-heals a stale high stage when the date is far in the future", async () => {
    const [v] = await db.insert(vehicles).values({
      slug: "comp-cron-heal", plate: "PL-CRON-HEAL", class: "Compact", name: "Heal Car", seats: 4,
      transmission: "Manual", doors: 4, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
      insuranceExpiresOn: "2030-01-01", insuranceAlertStage: 3,
    }).returning();
    await runComplianceAlerts(NOW_OVER);
    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, v!.id));
    expect(row!.insuranceAlertStage).toBe(0);
    expect((await listNotifications(200)).notifications.some((n) => n.title.includes("PL-CRON-HEAL"))).toBe(false);
  });
});

describe("complianceOverview", () => {
  it("lists due-soon and overdue documents sorted by urgency, excluding far-future and retired", async () => {
    const NOW = new Date("2027-06-23T12:00:00-04:00");
    const { items } = await complianceOverview(NOW);
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < items.length; i++) {
      expect(items[i]!.daysLeft).toBeGreaterThanOrEqual(items[i - 1]!.daysLeft);
    }
    const heal = items.find((i) => i.plate === "PL-CRON-HEAL");
    expect(heal).toBeUndefined(); // 2030 is far outside the window
    expect(items.some((i) => i.plate === "PL-CRON-RET")).toBe(false); // retired
    const schemaCar = items.find((i) => i.plate === "PL-COMP-1" && i.kind === "insurance");
    expect(schemaCar).toBeDefined(); // 2027-03-01 is overdue at NOW
    expect(schemaCar!.daysLeft).toBeLessThan(0);
    expect(schemaCar!.dueOn).toBe("2027-03-01");
    expect(schemaCar!.name).toBe("Comp Car");
    expect(typeof schemaCar!.vehicleId).toBe("string");
  });
});
```

- [ ] Run the test to verify it fails: `npm test -- --no-file-parallelism src/test/compliance-alerts.test.ts`. Expected failure: `Cannot find module '@/lib/admin/compliance'` (or vitest's equivalent import resolution error).

- [ ] Write the implementation. Create `src/lib/admin/compliance.ts` with exactly:

```ts
/**
 * Compliance alerts (wave 03): insurance + inspection expiry tracking.
 *
 * Each vehicle carries two document dates (insuranceExpiresOn, inspectionDueOn)
 * and a per-document alert stage used as a dedup marker:
 *   0 = nothing fired, 1 = first warning fired (settings.complianceAlertDays
 *   before the date), 2 = one-week warning fired, 3 = overdue fired.
 * The daily cron computes the TARGET stage purely from the date and fires only
 * when target > recorded, so each stage alerts exactly once. Entering a new
 * future date resets the recorded stage (updateVehicle does that); the cron
 * also lowers a stale stage quietly, so any write path self-heals.
 *
 * Firing is best-effort by construction: notifyAdmin() and alertOwner() never
 * throw, so a notification failure cannot break the cron run.
 */
import { eq, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { vehicles } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";
import { notifyAdmin, alertOwner } from "@/lib/notify";
import { adminDocumentExpiringEmail } from "@/lib/email/templates";

export type ComplianceKind = "insurance" | "inspection";

export interface ComplianceItem {
  vehicleId: string;
  name: string;
  plate: string;
  kind: ComplianceKind;
  dueOn: string;
  daysLeft: number;
}

const DAY_MS = 86_400_000;
/** The client's "one week before" stage. Fixed; only the first warning is a setting. */
const WEEK_STAGE_DAYS = 7;

/** Calendar date (YYYY-MM-DD) of `now` in the operator's timezone (America/Aruba). */
function arubaDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Aruba" }).format(now);
}

/** Whole days from `today` until `dueOn` (both YYYY-MM-DD). Negative = overdue. */
export function daysUntil(today: string, dueOn: string): number {
  return Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

/**
 * 0 = no alert yet, 1 = first warning, 2 = one week, 3 = overdue.
 * Checked most-urgent-first, so a firstWarningDays below 7 simply collapses
 * stage 1 into stage 2 instead of breaking the ladder.
 */
export function targetStage(daysLeft: number, firstWarningDays: number): number {
  if (daysLeft < 0) return 3;
  if (daysLeft <= WEEK_STAGE_DAYS) return 2;
  if (daysLeft <= firstWarningDays) return 1;
  return 0;
}

/**
 * Daily staged alert run. For every non-retired vehicle and each tracked
 * document, fire bell + owner email + WhatsApp when the date has entered a new
 * alert stage since the last run. Returns how many alerts fired.
 */
export async function runComplianceAlerts(now = new Date()): Promise<{ fired: number }> {
  const db = await getDb();
  const settings = await getSettings();
  const today = arubaDate(now);
  const fleet = await db.select().from(vehicles).where(ne(vehicles.status, "retired"));
  let fired = 0;

  for (const v of fleet) {
    const docs = [
      { kind: "insurance" as const, dueOn: v.insuranceExpiresOn, recorded: v.insuranceAlertStage },
      { kind: "inspection" as const, dueOn: v.inspectionDueOn, recorded: v.inspectionAlertStage },
    ];
    for (const doc of docs) {
      if (!doc.dueOn) continue;
      const daysLeft = daysUntil(today, doc.dueOn);
      const target = targetStage(daysLeft, settings.complianceAlertDays);
      if (target === doc.recorded) continue;

      const stagePatch = doc.kind === "insurance"
        ? { insuranceAlertStage: target }
        : { inspectionAlertStage: target };

      if (target < doc.recorded) {
        // The date moved into the future through some path that skipped the
        // form reset. Lower the marker quietly so the next cycle can fire.
        await db.update(vehicles).set({ ...stagePatch, updatedAt: now }).where(eq(vehicles.id, v.id));
        continue;
      }

      const overdue = target === 3;
      const docName = doc.kind === "insurance" ? "Insurance" : "Inspection";
      const title = overdue
        ? `${docName} overdue: ${v.name} (${v.plate})`
        : `${docName} due soon: ${v.name} (${v.plate})`;
      const body = overdue
        ? `Was due on ${doc.dueOn}.`
        : `Due on ${doc.dueOn} (${daysLeft} ${daysLeft === 1 ? "day" : "days"} left).`;

      await notifyAdmin({ level: overdue ? "critical" : "warning", type: "vehicle.document_expiring", title, body });
      const email = adminDocumentExpiringEmail({ vehicleName: v.name, plate: v.plate, kind: doc.kind, dueOn: doc.dueOn, daysLeft });
      await alertOwner({ type: "vehicle.document_expiring", subject: email.subject, html: email.html, whatsappText: `${title}. ${body}` });
      await db.update(vehicles).set({ ...stagePatch, updatedAt: now }).where(eq(vehicles.id, v.id));
      fired++;
    }
  }
  return { fired };
}

/**
 * Dashboard feed: every non-retired vehicle document due within the
 * first-warning window or overdue, most urgent first.
 */
export async function complianceOverview(now = new Date()): Promise<{ items: ComplianceItem[] }> {
  const db = await getDb();
  const settings = await getSettings();
  const today = arubaDate(now);
  const fleet = await db.select().from(vehicles).where(ne(vehicles.status, "retired"));
  const items: ComplianceItem[] = [];
  for (const v of fleet) {
    const docs = [
      { kind: "insurance" as const, dueOn: v.insuranceExpiresOn },
      { kind: "inspection" as const, dueOn: v.inspectionDueOn },
    ];
    for (const doc of docs) {
      if (!doc.dueOn) continue;
      const daysLeft = daysUntil(today, doc.dueOn);
      if (daysLeft > settings.complianceAlertDays) continue;
      items.push({ vehicleId: v.id, name: v.name, plate: v.plate, kind: doc.kind, dueOn: doc.dueOn, daysLeft });
    }
  }
  items.sort((a, b) => a.daysLeft - b.daysLeft);
  return { items };
}
```

- [ ] Run the test to verify it passes: `npm test -- --no-file-parallelism src/test/compliance-alerts.test.ts`. Expected: all tests in the file green. Note: `alertOwner` runs for real inside the tests but is a no-op there (`adminAlertRecipients` defaults to `[]` and the Resend/WhatsApp env is unset, so email is skip-logged and WhatsApp logs `whatsapp_skipped_not_configured`); no mocking is needed.

- [ ] Typecheck: `npx tsc --noEmit`. Expected: no errors.

- [ ] Commit:

```bash
git add src/lib/admin/compliance.ts src/test/compliance-alerts.test.ts
git commit -m "feat(compliance): runComplianceAlerts staged 30d/7d/overdue + complianceOverview"
```

---

### Task 5: Cron route `GET /api/cron/compliance-alerts` + vercel.json schedule

**Files:**
- Create: `src/app/api/cron/compliance-alerts/route.ts`
- Modify: `vercel.json` (crons array, currently lines 3-8)
- Test: `src/test/compliance-alerts.test.ts` (append)

**Interfaces:**
- Consumes: `runComplianceAlerts(now?: Date): Promise<{ fired: number }>` from `@/lib/admin/compliance` (Task 4); `env.CRON_SECRET` from `@/env` (optional string, default `""`); `logger` from `@/lib/logger`. Pattern copied 1:1 from the existing `src/app/api/cron/expire-holds/route.ts` (plain exported `GET`, not `withRoute`; bearer check; refuses to run when the secret is unset).
- Produces (seam names): route `GET /api/cron/compliance-alerts` returning `{ ok: true, fired: number }` on success and 401 `{ error: "Unauthorized" }` otherwise; `vercel.json` cron entry `{"path": "/api/cron/compliance-alerts", "schedule": "0 9 * * *"}` (daily 09:00 UTC, about 05:00 Aruba).

**Steps:**

- [ ] Write the failing test. Append to `src/test/compliance-alerts.test.ts`. Add this import at the top of the file:

```ts
import { GET as cronGet } from "@/app/api/cron/compliance-alerts/route";
```

Then append at the end of the file:

```ts
describe("cron route GET /api/cron/compliance-alerts", () => {
  it("refuses to run without the CRON_SECRET bearer", async () => {
    const bare = await cronGet(new Request("http://localhost/api/cron/compliance-alerts"));
    expect(bare.status).toBe(401);
    // In tests CRON_SECRET is unset (empty), so even a matching empty bearer
    // must be refused: the endpoint fails closed when no secret is configured.
    const empty = await cronGet(new Request("http://localhost/api/cron/compliance-alerts", {
      headers: { authorization: "Bearer " },
    }));
    expect(empty.status).toBe(401);
    const wrong = await cronGet(new Request("http://localhost/api/cron/compliance-alerts", {
      headers: { authorization: "Bearer nope" },
    }));
    expect(wrong.status).toBe(401);
  });
});
```

- [ ] Run the test to verify it fails: `npm test -- --no-file-parallelism src/test/compliance-alerts.test.ts`. Expected failure: cannot resolve `@/app/api/cron/compliance-alerts/route`.

- [ ] Write the implementation. Create `src/app/api/cron/compliance-alerts/route.ts` with exactly:

```ts
import { NextResponse } from "next/server";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { runComplianceAlerts } from "@/lib/admin/compliance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/compliance-alerts (wave 03): daily insurance/inspection expiry
 * check. Called on a schedule by Vercel Cron (see vercel.json). Authenticated
 * by the CRON_SECRET bearer token Vercel sends; refuses to run without it.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  if (!env.CRON_SECRET || auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { fired } = await runComplianceAlerts();
  logger.info("cron_compliance_alerts", { fired });
  return NextResponse.json({ ok: true, fired });
}
```

- [ ] Edit `vercel.json` to register the schedule. Replace the whole file (it currently has only the expire-holds cron) with:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [
    {
      "path": "/api/cron/expire-holds",
      "schedule": "0 3 * * *"
    },
    {
      "path": "/api/cron/compliance-alerts",
      "schedule": "0 9 * * *"
    }
  ]
}
```

(If plan 01 or 02 already added other cron entries, keep them and append this one instead of replacing the file.)

- [ ] Run the test to verify it passes: `npm test -- --no-file-parallelism src/test/compliance-alerts.test.ts`. Expected: all green.

- [ ] Typecheck: `npx tsc --noEmit`. Expected: no errors.

- [ ] Commit:

```bash
git add src/app/api/cron/compliance-alerts/route.ts vercel.json src/test/compliance-alerts.test.ts
git commit -m "feat(compliance): daily compliance-alerts cron route + vercel schedule"
```

---

### Task 6: Admin read API `GET /api/admin/compliance` + dashboard compliance card

**Files:**
- Create: `src/app/api/admin/compliance/route.ts`
- Modify: `src/app/admin/(shell)/page.tsx` (interfaces block near line 17; state near line 45; effects near line 71; JSX between the stat strip ending near line 232 and the toolbar starting near line 234)
- Modify: `src/app/admin/(shell)/dashboard.css` (append)
- Modify: `src/app/admin/admin.css` (tag color variants, currently lines 181-184)
- Test: none for the route file itself. Do NOT import this route into vitest: `read()` calls `requireAdmin`, which uses `cookies()` from `next/headers` and throws outside a real Next request scope (that is why no existing test imports a guard-wrapped admin route; the only route handlers tested directly, `auth/request` and `early-access`, avoid `next/headers`). The business logic (`complianceOverview`) is fully unit-tested in Task 4; the guard plumbing is shared, already-tested infrastructure. Verification for this task = typecheck + lint + the manual check below.

**Interfaces:**
- Consumes: `complianceOverview(now?: Date): Promise<{ items: ComplianceItem[] }>` from `@/lib/admin/compliance` (Task 4); `withRoute` from `@/lib/http/handler`; `json(data, req)` from `@/lib/http/respond`; `read(req, fn)` from `@/lib/admin/guard` (admin-session guard for GETs; throws 401 into `withRoute`'s error funnel when unauthenticated); on the client, `apiGet<T>(path)` from `../client` (already imported in the page as part of `import { apiGet, api, apiPatch, apiDelete, type ApiError } from "../client";`).
- Produces (seam name, consumed by nothing later in this plan but part of the wave contract): `GET /api/admin/compliance` -> `{ items: [{vehicleId, name, plate, kind: 'insurance'|'inspection', dueOn, daysLeft}] }`. Also produces the shared `.tag.warn` amber tag variant in `src/app/admin/admin.css` that Task 7 reuses.

**Steps:**

- [ ] Write the route. Create `src/app/api/admin/compliance/route.ts` with exactly:

```ts
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { read } from "@/lib/admin/guard";
import { complianceOverview } from "@/lib/admin/compliance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute(async (req) => json(await read(req, () => complianceOverview()), req));
```

(This mirrors `src/app/api/admin/settings/route.ts` line 10 exactly: `withRoute` funnels any `requireAdmin` throw into a clean 401/403 response; `read` is the audit-consistent GET guard.)

- [ ] Run the existing suite to confirm nothing broke: `npm test -- --no-file-parallelism src/test/compliance-alerts.test.ts`. Expected: still all green (this task adds no test; see the Test note above for why the route is not imported into vitest).

- [ ] Add the shared amber tag variant. In `src/app/admin/admin.css`, directly after the line `.tag.def { background: rgba(79,168,201,.16); color: #2E7A96; }` (line 184), insert:

```css
.tag.warn { background: rgba(201,138,51,.16); color: #9A6A24; }
```

(Amber pulled from the board's pending color #C98A33 so the palette stays Sand & Surf.)

- [ ] Add the dashboard card. Edit `src/app/admin/(shell)/page.tsx`:

  1. After the existing interfaces block (directly below the `interface Planning { ... }` closing brace, near line 25), insert:

```ts
interface ComplianceItem { vehicleId: string; name: string; plate: string; kind: "insurance" | "inspection"; dueOn: string; daysLeft: number }
```

  2. Inside `AdminDashboard()`, next to the other `useState` calls (after `const [moveCand, setMoveCand] = ...`, near line 53), insert:

```ts
  const [compliance, setCompliance] = useState<ComplianceItem[]>([]);
```

  3. Directly after the existing `useEffect(() => { void load(); }, []);` (near line 71), insert:

```ts
  // Compliance card data. Best-effort: the board must render even if this call fails.
  useEffect(() => {
    apiGet<{ items: ComplianceItem[] }>("/api/admin/compliance")
      .then((d) => setCompliance(d.items))
      .catch(() => {});
  }, []);
```

  4. In the returned JSX, directly after the closing `</div>` of the `stat-strip` block (the block that ends with `<div className="s"><b>{stats.pending}</b><span>awaiting payment</span></div>` followed by `</div>`, near line 232) and before `<div className="pl-toolbar">`, insert:

```tsx
      {compliance.length > 0 && (
        <div className="panel pl-compliance" role="status">
          <div className="pl-compliance__head">
            <h2>Compliance</h2>
            <a href="/admin/fleet">Open Fleet</a>
          </div>
          <ul>
            {compliance.map((c) => (
              <li key={`${c.vehicleId}-${c.kind}`}>
                <span className={`tag ${c.daysLeft < 0 ? "off" : "warn"}`}>
                  {c.kind === "insurance" ? "Insurance" : "Inspection"} {c.daysLeft < 0 ? "overdue" : `${c.daysLeft}d`}
                </span>
                <b>{c.plate}</b> <small>{c.name}</small>
                <span className="pl-compliance__due">due {c.dueOn}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
```

- [ ] Append the card styles to `src/app/admin/(shell)/dashboard.css`:

```css
/* ---- Compliance card (wave 03): documents coming due, amber soon / red overdue.
   Rendered only when at least one document is inside the warning window. ---- */
.pl-compliance { margin-bottom: 1.1rem; }
.pl-compliance__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: .55rem;
}
.pl-compliance__head h2 { margin: 0; }
.pl-compliance__head a { font-size: .8rem; white-space: nowrap; }
.pl-compliance ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .4rem; }
.pl-compliance li { display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
.pl-compliance li small { color: var(--ink-mute); }
.pl-compliance__due {
  margin-left: auto;
  font-size: .75rem;
  color: var(--ink-mute);
  font-family: var(--font-mono);
}
```

- [ ] Typecheck and lint: `npx tsc --noEmit` then `npm run lint`. Expected: no errors.

- [ ] Manual verification (do not run `npm run build` while this dev server runs): start `npm run dev`, sign in to the admin, open `http://localhost:3000/admin/fleet`, edit any vehicle and set "Insurance expires" to a date about 10 days from today (Task 7 adds this field; if executing tasks strictly in order, instead set the date via the API: `PATCH /api/admin/vehicles/<id>` with body `{"insuranceExpiresOn":"<yyyy-mm-dd>"}` using the browser devtools fetch with the `X-CSRF-Token` header, or simply defer this manual check until after Task 7). Then open `http://localhost:3000/admin` and confirm: a "Compliance" panel appears between the stat strip and the toolbar, showing an amber tag like "Insurance 10d" with the plate and "due <date>"; a past date shows a red "Insurance overdue" tag; with no near-due documents the panel is absent entirely. The "Open Fleet" link navigates to `/admin/fleet`. Stop the dev server.

- [ ] Commit:

```bash
git add src/app/api/admin/compliance/route.ts "src/app/admin/(shell)/page.tsx" "src/app/admin/(shell)/dashboard.css" src/app/admin/admin.css
git commit -m "feat(admin): dashboard compliance card + GET /api/admin/compliance"
```

---

### Task 7: Fleet form DatePickers + list badges

**Files:**
- Modify: `src/app/admin/(shell)/fleet/page.tsx` (Vehicle interface lines 17-22, `empty` lines 27-30, `load` line 45, `save` lines 67-86, `edit` lines 88-99, table body Name cell near line 199, form grid lines 232-246)
- Modify: `src/app/admin/(shell)/fleet/fleet.css` (append)
- Test: manual + typecheck/lint (client component; the underlying persistence and badge math are already unit-tested in Tasks 2 and 4)

**Interfaces:**
- Consumes: `PATCH/POST /api/admin/vehicles[...]` accepting `insuranceExpiresOn` / `inspectionDueOn` (`YYYY-MM-DD` or null, Task 2); `GET /api/admin/vehicles` returning full rows including the new columns (the existing `listVehicles()` does `db.select()` so no server change is needed); `GET /api/admin/settings` returning `complianceAlertDays` (Task 1); `DatePicker` from `@/components/ui` with props `{ value: string; onChange: (iso: string) => void; ariaLabel?: string; placeholder?: string }` where `""` means empty/cleared; the `.tag.warn` amber variant added to `src/app/admin/admin.css` in Task 6.
- Produces: fleet UI only; no new seams.

**Steps:**

- [ ] Edit `src/app/admin/(shell)/fleet/page.tsx`:

  1. Change the react import (line 3) from

```ts
import { useEffect, useState, type FormEvent } from "react";
```

to

```ts
import { useEffect, useMemo, useState, type FormEvent } from "react";
```

  2. Extend the `Vehicle` interface (lines 17-22): after `depositCents: number | null; status: "active" | "maintenance" | "retired";` add

```ts
  insuranceExpiresOn: string | null; inspectionDueOn: string | null;
```

  3. Extend the `empty` form template (lines 27-30): after `day: "", week: "", month: "", deposit: "", status: "active",` add

```ts
  insurance: "", inspection: "",
```

  4. Replace the `load` function (line 45), currently

```ts
  async function load() { setVehicles(await apiGet<Vehicle[]>("/api/admin/vehicles")); }
```

with

```ts
  const [alertDays, setAlertDays] = useState(30);
  async function load() {
    const [vs, s] = await Promise.all([
      apiGet<Vehicle[]>("/api/admin/vehicles"),
      apiGet<{ complianceAlertDays: number }>("/api/admin/settings"),
    ]);
    setVehicles(vs);
    setAlertDays(s.complianceAlertDays);
  }
```

(Keep the `useState` call grouped with the other state hooks at the top of the component if the linter complains about hook ordering; it must run on every render like all hooks.)

  5. In `save` (lines 67-86), extend the `body` object: after `status: f.status,` add

```ts
      insuranceExpiresOn: f.insurance === "" ? null : f.insurance,
      inspectionDueOn: f.inspection === "" ? null : f.inspection,
```

  6. In `edit` (lines 88-99), extend the `setF({...})` object: after `status: v.status,` add

```ts
      insurance: v.insuranceExpiresOn ?? "", inspection: v.inspectionDueOn ?? "",
```

  7. Add the badge helpers inside the component, directly after the `const statusTag = ...` line (near line 144):

```ts
  const today = useMemo(() => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Aruba" }).format(new Date()), []);
  const daysLeft = (dueOn: string) => Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  function complianceBadges(v: Vehicle) {
    const out: { key: string; label: string; overdue: boolean }[] = [];
    for (const [name, dueOn] of [["Insurance", v.insuranceExpiresOn], ["Inspection", v.inspectionDueOn]] as const) {
      if (!dueOn) continue;
      const d = daysLeft(dueOn);
      if (d > alertDays) continue;
      out.push({ key: name, label: d < 0 ? `${name} overdue` : `${name} ${d}d`, overdue: d < 0 });
    }
    return out;
  }
```

  8. In the table body, replace the Name cell (near line 199), currently

```tsx
                  <td>{v.name}<div className="fleet-slug">{v.slug}</div></td>
```

with

```tsx
                  <td>{v.name}<div className="fleet-slug">{v.slug}</div>
                    {complianceBadges(v).length > 0 && (
                      <div className="fleet-compliance">
                        {complianceBadges(v).map((b) => (
                          <span key={b.key} className={`tag ${b.overdue ? "off" : "warn"}`}>{b.label}</span>
                        ))}
                      </div>
                    )}
                  </td>
```

  9. In the vehicle form grid (inside the `Modal`, lines 232-246), directly after the Deposit label

```tsx
            <label>Deposit (USD, blank = TBC)<input type="number" step="0.01" min="0" value={f.deposit} onChange={(e) => setF({ ...f, deposit: e.target.value })} /></label>
```

insert:

```tsx
            <label>Insurance expires<DatePicker value={f.insurance} onChange={(iso) => setF({ ...f, insurance: iso })} ariaLabel="Insurance expires" placeholder="Not tracked" /></label>
            <label>Inspection due<DatePicker value={f.inspection} onChange={(iso) => setF({ ...f, inspection: iso })} ariaLabel="Inspection due" placeholder="Not tracked" /></label>
```

(`DatePicker` is already imported in this file. Clearing a date via the picker's Clear button sends `""`, which `save` converts to `null`, which untracks the document; entering a new date resets the alert ladder server-side per Task 2.)

- [ ] Append to `src/app/admin/(shell)/fleet/fleet.css`:

```css
/* Compliance badges under the vehicle name (wave 03): amber = due soon within
   the warning window, red = overdue. */
.fleet-grid .fleet-compliance {
  display: flex;
  gap: .3rem;
  margin-top: .25rem;
  flex-wrap: wrap;
}
```

- [ ] Typecheck and lint: `npx tsc --noEmit` then `npm run lint`. Expected: no errors.

- [ ] Run the full suite to make sure nothing regressed: `npm test -- --no-file-parallelism`. Expected: all green.

- [ ] Manual verification: start `npm run dev`, open `http://localhost:3000/admin/fleet`. Confirm: the Add/Edit vehicle modal shows "Insurance expires" and "Inspection due" DatePickers with "Not tracked" placeholders; setting an insurance date about 10 days out and saving shows an amber "Insurance 10d" badge under the vehicle's name in the list; setting a past date shows red "Insurance overdue"; clearing the date via the picker's Clear button and saving removes the badge; re-editing the vehicle shows the saved dates pre-filled. Stop the dev server.

- [ ] Commit:

```bash
git add "src/app/admin/(shell)/fleet/page.tsx" "src/app/admin/(shell)/fleet/fleet.css"
git commit -m "feat(admin): fleet expiry DatePickers + due-soon compliance badges"
```

---

### Task 8: Settings page field for `complianceAlertDays` + final wave-03 verification

**Files:**
- Modify: `src/app/admin/(shell)/settings/page.tsx` (Settings interface lines 16-20, skeleton count line 125, save payload lines 67-77, form grid lines 156-193)
- Test: manual + typecheck/lint (the schema/API side is unit-tested in Task 2)

**Interfaces:**
- Consumes: `GET /api/admin/settings` returning `complianceAlertDays: number` and `PATCH /api/admin/settings` accepting it (Tasks 1-2).
- Produces: settings UI only; no new seams.

**Steps:**

- [ ] Edit `src/app/admin/(shell)/settings/page.tsx`:

  1. Extend the `Settings` interface (lines 16-20): after `maxAdvanceDays: number; licenseRetentionDays: number;` add

```ts
  complianceAlertDays: number;
```

(Plans 01 and 02 may already have added their own fields here; just append this one.)

  2. In `save` (the `apiPatch` payload, lines 67-77), after `licenseRetentionDays: s.licenseRetentionDays,` add

```ts
        complianceAlertDays: s.complianceAlertDays,
```

  3. In the form grid, directly after the licence retention label

```tsx
              <label>Licence document retention (days after return)
                <input type="number" min="1" max="3650" value={s.licenseRetentionDays}
                  onChange={(e) => setS({ ...s, licenseRetentionDays: Number(e.target.value) })} />
              </label>
```

insert:

```tsx
              <label>Compliance first warning (days before a document expires)
                <input type="number" min="1" max="365" value={s.complianceAlertDays}
                  onChange={(e) => setS({ ...s, complianceAlertDays: Number(e.target.value) })} />
              </label>
```

  4. Bump the loading-skeleton field count to match the extra field: in the skeleton block (near line 125), change `Array.from({ length: 9 })` to `Array.from({ length: 10 })` (if plans 01/02 already raised this number, raise it by one more).

- [ ] Typecheck and lint: `npx tsc --noEmit` then `npm run lint`. Expected: no errors.

- [ ] Manual verification: start `npm run dev`, open `http://localhost:3000/admin/settings`. Confirm: a "Compliance first warning (days before a document expires)" field shows 30, changing it to 45 and clicking "Save settings" shows the success toast and survives a reload; entering 0 is rejected by the API with an error toast. Set it back to 30 and save. Stop the dev server.

- [ ] Final wave-03 verification, in this order:

```bash
npm test -- --no-file-parallelism
npx tsc --noEmit
npm run lint
```

Expected: full suite green (including `src/test/compliance-alerts.test.ts` and the extended `src/test/email-templates.test.ts`), no type errors, no lint errors.

- [ ] Commit:

```bash
git add "src/app/admin/(shell)/settings/page.tsx"
git commit -m "feat(admin): compliance first-warning threshold in Settings"
```
