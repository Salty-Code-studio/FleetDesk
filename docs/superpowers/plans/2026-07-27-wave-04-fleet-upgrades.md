# Fleet Management Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the fleet page structured vehicle identity (make/model/year/color with an auto-composed name), a grouped/searchable/filterable fleet list, and per-car notes with open-note badges on the fleet list and planning board plus a one-tap escalate-note-to-availability-block.

**Architecture:** Two additive drizzle migrations (four nullable `vehicles` columns; a new `vehicle_notes` table) feed a new `src/lib/admin/vehicle-notes.ts` lib consumed by thin `withRoute` admin API routes (guarded by `read`/`mutate`). The admin fleet page (`src/app/admin/(shell)/fleet/page.tsx`) gains form fields, class-grouped rendering with sticky headers, search, chips, and a notes Drawer; the planning board lib and page surface open-note counts as badges.

**Tech Stack:** Next.js 15 (App Router, route handlers), drizzle-orm + PGlite (dev/test) / Supabase Postgres (prod), zod 3.24 at every boundary, vitest, Sand & Surf admin kit (`@/app/admin/_ui`).

**Wave context:** This is plan 04 of the 2026-07 feature wave (spec Workstream 6). It executes on branch `feat/wave-2026-07` AFTER plans 01 (time foundation), 02 (payments + BookingDrawer) and 03 (compliance alerts) are merged. Seams doc: `docs/superpowers/plans/SEAMS-2026-07-wave.md` — every cross-plan name below matches it verbatim.

## Global Constraints

- Tests: `npm test -- --no-file-parallelism` (vitest). New features land with tests.
- NEVER `npm run build` while a `next dev` server is running (shared `.next` corrupts).
- Migrations: `npm run db:generate` for drizzle diffs; hand-written SQL files in `./drizzle` for constraints/enum surgery (precedent: 0002, 0007, 0010). Applied with `npm run db:migrate`. Must work on BOTH PGlite (`pglite://`, dev/test) and Postgres (Supabase prod).
- Admin mutations go through `mutate(req, action, fn)` from `src/lib/admin/guard.ts` (audit-logged); reads through `read(req, fn)`.
- Admin UI: reuse `Modal, Drawer, useToast, useConfirm, Skeleton, EmptyState, registerPaletteAction` from `@/app/admin/_ui` and `DatePicker, Select` from `@/components/ui`. Strict CSP: no external assets ever. Money is integer cents.
- Copy: dash-free house style (no em-dashes), warm/human tone.
- Timezone: operator-local day logic uses `America/Aruba` (existing `arubaToday()` precedent).
- Design principle: less clicking. One click from a planning bar opens the BookingDrawer with everything in it.
- Workstream 6 specifics (from the spec): `make`, `model`, `year` (int), `color` are separate fields; `name` stays for display/compat and the form composes it from make + model by default but stays editable. Fleet list groups by class in the original CLASS_ORDER (Economy, Compact, SUV, 4x4, Van) with sticky group headers, a search bar filtering on plate / make / model / name, and class filter chips. `vehicle_notes` per seams; notes drawer per vehicle (add, list newest-first, resolve); open-note count badge on the fleet row and on the planning-board vehicle label (tooltip); one-tap escalate to an availability block ("Block car for this").
- Public class cards need NO change: customers book a class, and the vehicle `name` (now composed from make + model by default) is what public surfaces already render.

## Decisions this plan makes (spec left them open)

- **Escalation block shape:** one tap (plus a confirm dialog, matching house style for state-changing actions) creates a `maintenance` availability block starting today 00:00 Aruba for **7 days**, `reason` = the note body (first 200 chars). Staff adjust or delete it under the existing Blocks drawer. The note stays open until someone resolves it, so the badge keeps nagging until the work is actually done.
- **`vehicle_notes` schema file:** lives in a NEW file `src/lib/db/schema/vehicle-notes.ts` (not `fleet.ts`), because `fleet.ts` importing `adminUsers` would create the module cycle fleet → admin → licenses → bookings → fleet. The new leaf file imports from `./fleet` and `./admin` safely.
- **Open-note counts reach the UI** by extending existing responses additively: `GET /api/admin/vehicles` rows gain `openNotes: number`, and `getPlanning()`'s `PlanningVehicle` gains `openNotes: number`. No new list endpoints.
- **Reopen is supported:** `PATCH /api/admin/notes/[id]` takes `{ resolved: boolean }` both ways (audit action differs).

## Drift warnings for implementers (plans 01–03 landed before you)

- `availability_blocks` now has `startAt` → `start_at`, `endAt` → `end_at` (timestamptz) per the seams doc, NOT the old `startDate`/`endDate` date columns. Task 3 targets the new names.
- Plan 03 added compliance fields (`insuranceExpiresOn`, `inspectionDueOn`, alert stages) to `vehicles` and badges to the fleet page. When a task below says "the existing row JSX" or shows today's form fields, KEEP everything plan 03 added; the code blocks in this plan show the pre-03 baseline plus this plan's additions. Never delete a field or cell you find in the file that this plan does not mention.
- Plans 01/02 reshaped the planning board page (`src/app/admin/(shell)/page.tsx`): bars are fractional, BookingDrawer replaced BookingPanel. The anchors used in Tasks 5 and 9 (`byVehicle.set(...)` seeding loop, the `pl-label` element) survive those plans; locate them by the quoted text, not by line number.

---

### Task 1: Vehicle identity columns (make, model, year, color)

**Files:**
- Modify: `src/lib/db/schema/fleet.ts` (the `vehicles` table, after the `name` column, line 13 in the pre-wave file)
- Modify: `src/lib/admin/vehicles.ts` (`VehicleCreateSchema`, after the `name` field, line 16 in the pre-wave file)
- Create: `drizzle/<next>_*.sql` (generated by `npm run db:generate`; do NOT pick the number yourself)
- Test: `src/test/fleet-identity.test.ts`

**Interfaces:**
- Consumes: `createVehicle(input)`, `updateVehicle(id, patch)`, `VehicleCreateSchema`, `VehiclePatchSchema = VehicleCreateSchema.partial().strict()` from `src/lib/admin/vehicles.ts`; `runMigrations()` from `@/lib/db/migrate`.
- Produces (seam, verbatim from the seams doc): drizzle properties on `vehicles` — `make` → `make` text nullable, `model` → `model` text nullable, `year` → `year` integer nullable, `color` → `color` text nullable. `name` kept. Zod: `VehicleCreateSchema` accepts optional/nullable `make` (string ≤60), `model` (string ≤60), `year` (int 1950–2100), `color` (string ≤40). Later tasks (2, 6, 7) rely on `Vehicle` (the `$inferSelect` type) carrying `make: string | null; model: string | null; year: number | null; color: string | null`.

**Steps:**

- [ ] Write the failing test. Create `src/test/fleet-identity.test.ts` with exactly:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { createVehicle, updateVehicle, VehicleCreateSchema } from "@/lib/admin/vehicles";

const base = {
  class: "Compact" as const, name: "Kia Picanto", seats: 5, transmission: "Automatic" as const,
  doors: 4, priceDayCents: 4500, priceWeekCents: 27000, priceMonthCents: 99000,
};
let plateSeq = 7000;
const nextPlate = () => "ID-" + plateSeq++;

beforeAll(async () => { await runMigrations(); });

describe("vehicle identity fields (make, model, year, color)", () => {
  it("accepts and persists make, model, year and color", async () => {
    const input = VehicleCreateSchema.parse({
      ...base, plate: nextPlate(), slug: "identity-full",
      make: "Kia", model: "Picanto", year: 2023, color: "White",
    });
    const v = await createVehicle(input);
    expect(v.make).toBe("Kia");
    expect(v.model).toBe("Picanto");
    expect(v.year).toBe(2023);
    expect(v.color).toBe("White");
  });

  it("defaults all identity fields to null when omitted", async () => {
    const v = await createVehicle(VehicleCreateSchema.parse({ ...base, plate: nextPlate(), slug: "identity-none" }));
    expect(v.make).toBeNull();
    expect(v.model).toBeNull();
    expect(v.year).toBeNull();
    expect(v.color).toBeNull();
  });

  it("patches identity fields and allows clearing with null", async () => {
    const v = await createVehicle(VehicleCreateSchema.parse({
      ...base, plate: nextPlate(), slug: "identity-patch", make: "Suzuki", model: "Jimny", year: 2019, color: "Green",
    }));
    const updated = await updateVehicle(v.id, { model: "Jimny Sierra", color: null });
    expect(updated.make).toBe("Suzuki");
    expect(updated.model).toBe("Jimny Sierra");
    expect(updated.color).toBeNull();
  });

  it("rejects a non-integer or out-of-range year and an empty make", () => {
    expect(VehicleCreateSchema.safeParse({ ...base, plate: nextPlate(), slug: "y1", year: 2023.5 }).success).toBe(false);
    expect(VehicleCreateSchema.safeParse({ ...base, plate: nextPlate(), slug: "y2", year: 1899 }).success).toBe(false);
    expect(VehicleCreateSchema.safeParse({ ...base, plate: nextPlate(), slug: "y3", make: "   " }).success).toBe(false);
  });
});
```

- [ ] Run the test to verify it fails: `npm test -- --no-file-parallelism src/test/fleet-identity.test.ts`. Expected failure: every `it` throws a `ZodError` with `unrecognized_keys` (e.g. `Unrecognized key(s) in object: 'make'`) because `VehicleCreateSchema` is `.strict()` and does not know the new fields yet (the "defaults to null" test fails on the `expect(v.make).toBeNull()` line with a TypeScript/undefined mismatch instead — also a failure).

- [ ] Add the columns to `src/lib/db/schema/fleet.ts`. In the `vehicles` table, directly below the line `name: text("name").notNull(),` insert:

```ts
  make: text("make"),
  model: text("model"),
  year: integer("year"),
  color: text("color"),
```

(`text` and `integer` are already imported in this file.)

- [ ] Generate the migration: run `npm run db:generate`. Expect drizzle-kit to create one new SQL file in `./drizzle` (next number after the current highest; other wave plans have already added migrations past 0014, so do not assume a number) plus an updated `drizzle/meta/_journal.json` and snapshot. The generated SQL must be exactly four ALTERs:

```sql
ALTER TABLE "vehicles" ADD COLUMN "make" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "year" integer;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "color" text;
```

If the generated file contains anything else (drops, renames), STOP: the schema edit was wrong; fix it and delete/regenerate the migration. Never hand-edit `_journal.json` for generated migrations — `db:generate` maintains it.

- [ ] Extend the zod schema in `src/lib/admin/vehicles.ts`. In `VehicleCreateSchema`, directly below the line `name: z.string().trim().min(1).max(120),` insert:

```ts
  make: z.string().trim().min(1).max(60).nullable().optional(),
  model: z.string().trim().min(1).max(60).nullable().optional(),
  year: z.number().int().min(1950).max(2100).nullable().optional(),
  color: z.string().trim().min(1).max(40).nullable().optional(),
```

(`VehiclePatchSchema = VehicleCreateSchema.partial().strict()` picks these up automatically, which is what makes `{ color: null }` a valid clearing patch.)

- [ ] Run the test to verify it passes: `npm test -- --no-file-parallelism src/test/fleet-identity.test.ts` — 4 tests pass. (Tests apply migrations themselves via `runMigrations()` against `pglite://memory`; no `npm run db:migrate` needed for the suite.)

- [ ] Run the full suite to catch regressions: `npm test -- --no-file-parallelism` — everything green.

- [ ] Commit:

```
git add src/lib/db/schema/fleet.ts src/lib/admin/vehicles.ts src/test/fleet-identity.test.ts drizzle
git commit -m "feat(fleet): make, model, year and color columns on vehicles"
```

---

### Task 2: vehicle_notes table + notes lib (create, list, resolve, open counts)

**Files:**
- Create: `src/lib/db/schema/vehicle-notes.ts`
- Modify: `src/lib/db/schema/index.ts` (add one export line)
- Create: `src/lib/admin/vehicle-notes.ts`
- Create: `drizzle/<next>_*.sql` (generated by `npm run db:generate`)
- Test: `src/test/vehicle-notes.test.ts`

**Interfaces:**
- Consumes: `getDb()` from `@/lib/db/client`; `runMigrations()` from `@/lib/db/migrate`; `adminUsers` and `vehicles` drizzle tables from `@/lib/db/schema`; `getVehicle(id): Promise<Vehicle | undefined>` and `createVehicle`/`VehicleCreateSchema` from `@/lib/admin/vehicles`; `Errors.notFound(message)` from `@/lib/http/errors`; `expectReject(promise, pattern)` from `src/test/util.ts`.
- Produces (seam table, verbatim from the seams doc — `vehicle_notes`: `id` uuid PK, `vehicleId` FK→vehicles cascade, `body` text NOT NULL, `createdBy` FK→admin_users, `createdAt` timestamptz default now, `resolvedAt` timestamptz nullable) plus this plan's lib API that Tasks 3–5 and 8 consume:
  - `type VehicleNote = typeof vehicleNotes.$inferSelect` (fields: `id: string; vehicleId: string; body: string; createdBy: string | null; createdAt: Date; resolvedAt: Date | null`)
  - `NoteCreateSchema` (zod, `{ body: string }`, trimmed, 1–500 chars, `.strict()`)
  - `NotePatchSchema` (zod, `{ resolved: boolean }`, `.strict()`)
  - `createNote(vehicleId: string, raw: { body: string }, createdBy: string | null): Promise<VehicleNote>`
  - `listNotes(vehicleId: string): Promise<VehicleNote[]>` (newest first)
  - `getNote(id: string): Promise<VehicleNote | undefined>`
  - `setNoteResolved(id: string, resolved: boolean): Promise<VehicleNote>`
  - `openNoteCounts(): Promise<Map<string, number>>` (vehicleId → open-note count; vehicles with zero open notes are absent from the map)

**Steps:**

- [ ] Write the failing test. Create `src/test/vehicle-notes.test.ts` with exactly:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { adminUsers, vehicleNotes } from "@/lib/db/schema";
import { createVehicle, VehicleCreateSchema } from "@/lib/admin/vehicles";
import { createNote, listNotes, setNoteResolved, openNoteCounts, NoteCreateSchema } from "@/lib/admin/vehicle-notes";
import { expectReject } from "./util";

const base = {
  class: "SUV" as const, name: "Note Wagon", seats: 5, transmission: "Automatic" as const,
  doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000,
};
let seq = 8000;
const nextPlate = () => "VN-" + seq++;
const nextSlug = () => "note-car-" + seq;

let db: Awaited<ReturnType<typeof getDb>>;
let adminId: string;

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [a] = await db.insert(adminUsers).values({
    email: "notes-admin@fleetdesk.app",
    passwordHash: "$argon2id$placeholder-hash-not-a-real-credential",
  }).returning();
  adminId = a!.id;
});

async function makeVehicle() {
  return createVehicle(VehicleCreateSchema.parse({ ...base, plate: nextPlate(), slug: nextSlug() }));
}

describe("vehicle notes", () => {
  it("creates a note against a vehicle with the acting admin recorded", async () => {
    const v = await makeVehicle();
    const n = await createNote(v.id, { body: "  Customer says brakes feel soft  " }, adminId);
    expect(n.vehicleId).toBe(v.id);
    expect(n.body).toBe("Customer says brakes feel soft"); // trimmed at the boundary
    expect(n.createdBy).toBe(adminId);
    expect(n.resolvedAt).toBeNull();
  });

  it("rejects an empty body and an unknown vehicle", async () => {
    expect(NoteCreateSchema.safeParse({ body: "   " }).success).toBe(false);
    await expectReject(createNote("00000000-0000-0000-0000-000000000000", { body: "hello" }, adminId), /not found/i);
  });

  it("lists notes newest first", async () => {
    const v = await makeVehicle();
    await db.insert(vehicleNotes).values({ vehicleId: v.id, body: "older", createdAt: new Date("2026-07-01T12:00:00Z") });
    await db.insert(vehicleNotes).values({ vehicleId: v.id, body: "newer", createdAt: new Date("2026-07-02T12:00:00Z") });
    const notes = await listNotes(v.id);
    expect(notes.map((n) => n.body)).toEqual(["newer", "older"]);
  });

  it("resolves and reopens a note", async () => {
    const v = await makeVehicle();
    const n = await createNote(v.id, { body: "Wiper blade worn" }, adminId);
    const resolved = await setNoteResolved(n.id, true);
    expect(resolved.resolvedAt).not.toBeNull();
    const reopened = await setNoteResolved(n.id, false);
    expect(reopened.resolvedAt).toBeNull();
    await expectReject(setNoteResolved("00000000-0000-0000-0000-000000000000", true), /not found/i);
  });

  it("counts only open notes per vehicle", async () => {
    const a = await makeVehicle();
    const b = await makeVehicle();
    await createNote(a.id, { body: "one" }, adminId);
    await createNote(a.id, { body: "two" }, adminId);
    const done = await createNote(a.id, { body: "three" }, adminId);
    await setNoteResolved(done.id, true);
    const counts = await openNoteCounts();
    expect(counts.get(a.id)).toBe(2);
    expect(counts.get(b.id)).toBeUndefined();
  });
});
```

- [ ] Run the test to verify it fails: `npm test -- --no-file-parallelism src/test/vehicle-notes.test.ts`. Expected failure: the file fails to load with a module resolution error — `Cannot find module '@/lib/admin/vehicle-notes'` (and `vehicleNotes` is not exported from `@/lib/db/schema`).

- [ ] Create the schema file `src/lib/db/schema/vehicle-notes.ts` with exactly:

```ts
import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { vehicles } from "./fleet";
import { adminUsers } from "./admin";

/**
 * Per-car operational notes (complaints, future maintenance). Open notes
 * (resolvedAt IS NULL) surface as count badges on the fleet list and the
 * planning board; a note can be escalated to an availability block in one tap.
 * Lives in its own file (not fleet.ts): fleet.ts importing adminUsers would
 * close the module cycle fleet -> admin -> licenses -> bookings -> fleet.
 */
export const vehicleNotes = pgTable("vehicle_notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  vehicleId: uuid("vehicle_id").notNull().references(() => vehicles.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  createdBy: uuid("created_by").references(() => adminUsers.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [index("vehicle_notes_vehicle_idx").on(t.vehicleId)]);
```

- [ ] Register it in `src/lib/db/schema/index.ts`: add this line at the end of the export list:

```ts
export * from "./vehicle-notes";
```

- [ ] Generate the migration: run `npm run db:generate`. Expect one new SQL file whose content is (constraint names may include drizzle's generated suffixes — that is fine):

```sql
CREATE TABLE "vehicle_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "vehicle_notes" ADD CONSTRAINT "vehicle_notes_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_notes" ADD CONSTRAINT "vehicle_notes_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vehicle_notes_vehicle_idx" ON "vehicle_notes" USING btree ("vehicle_id");
```

If it also emits unrelated diffs, STOP and reconcile before continuing.

- [ ] Create the lib `src/lib/admin/vehicle-notes.ts` with exactly:

```ts
import { z } from "zod";
import { desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { vehicleNotes } from "@/lib/db/schema";
import { getVehicle } from "@/lib/admin/vehicles";
import { Errors } from "@/lib/http/errors";

export type VehicleNote = typeof vehicleNotes.$inferSelect;

export const NoteCreateSchema = z.object({
  body: z.string().trim().min(1, "Write something first").max(500),
}).strict();

export const NotePatchSchema = z.object({ resolved: z.boolean() }).strict();

export async function createNote(
  vehicleId: string,
  raw: z.input<typeof NoteCreateSchema>,
  createdBy: string | null,
): Promise<VehicleNote> {
  const input = NoteCreateSchema.parse(raw);
  const db = await getDb();
  const vehicle = await getVehicle(vehicleId);
  if (!vehicle) throw Errors.notFound("Vehicle not found");
  const [row] = await db.insert(vehicleNotes).values({ vehicleId, body: input.body, createdBy }).returning();
  return row!;
}

export async function listNotes(vehicleId: string): Promise<VehicleNote[]> {
  const db = await getDb();
  return db.select().from(vehicleNotes)
    .where(eq(vehicleNotes.vehicleId, vehicleId))
    .orderBy(desc(vehicleNotes.createdAt), desc(vehicleNotes.id));
}

export async function getNote(id: string): Promise<VehicleNote | undefined> {
  const db = await getDb();
  const [row] = await db.select().from(vehicleNotes).where(eq(vehicleNotes.id, id));
  return row;
}

export async function setNoteResolved(id: string, resolved: boolean): Promise<VehicleNote> {
  const db = await getDb();
  const [row] = await db.update(vehicleNotes)
    .set({ resolvedAt: resolved ? new Date() : null })
    .where(eq(vehicleNotes.id, id))
    .returning();
  if (!row) throw Errors.notFound("Note not found");
  return row;
}

/** Open-note counts per vehicle in one grouped query (badges on fleet + planning). */
export async function openNoteCounts(): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db.select({
    vehicleId: vehicleNotes.vehicleId,
    n: sql<number>`count(*)::int`,
  }).from(vehicleNotes).where(isNull(vehicleNotes.resolvedAt)).groupBy(vehicleNotes.vehicleId);
  return new Map(rows.map((r) => [r.vehicleId, r.n]));
}
```

- [ ] Run the test to verify it passes: `npm test -- --no-file-parallelism src/test/vehicle-notes.test.ts` — 5 tests pass.

- [ ] Typecheck: `npx tsc --noEmit` — clean.

- [ ] Commit:

```
git add src/lib/db/schema/vehicle-notes.ts src/lib/db/schema/index.ts src/lib/admin/vehicle-notes.ts src/test/vehicle-notes.test.ts drizzle
git commit -m "feat(fleet): vehicle_notes table + notes lib (add, list, resolve, open counts)"
```

---

### Task 3: Escalate a note to an availability block

**Files:**
- Modify: `src/lib/admin/vehicle-notes.ts` (append; created in Task 2)
- Test: `src/test/vehicle-notes.test.ts` (append a describe block; created in Task 2)

**Interfaces:**
- Consumes: from Task 2 — `getNote(id): Promise<VehicleNote | undefined>`, `VehicleNote`, `openNoteCounts()`, `createNote`. From the repo — `availabilityBlocks` drizzle table from `@/lib/db/schema` which, after plan 01, has properties `vehicleId` (uuid), `startAt` → `start_at` timestamptz, `endAt` → `end_at` timestamptz, `type` (pgEnum `block_type`: `maintenance | carwash | cleaning | out_of_service | other`), `reason` (text, default ''). `arubaToday(): string` (YYYY-MM-DD in America/Aruba) from `@/lib/booking/public`. `Errors.notFound` from `@/lib/http/errors`.
- Produces (Tasks 4 and 8 consume):
  - `ESCALATION_BLOCK_DAYS = 7` (exported const)
  - `escalateNoteToBlock(noteId: string): Promise<{ note: VehicleNote; block: typeof availabilityBlocks.$inferSelect }>`

**Steps:**

- [ ] Write the failing test. Append to `src/test/vehicle-notes.test.ts`: extend the import from `@/lib/admin/vehicle-notes` to also include `escalateNoteToBlock`, add these two imports below the existing ones:

```ts
import { availabilityBlocks } from "@/lib/db/schema";
import { arubaToday } from "@/lib/booking/public";
```

(merge `availabilityBlocks` into the existing `@/lib/db/schema` import line: `import { adminUsers, vehicleNotes, availabilityBlocks } from "@/lib/db/schema";`), then append this describe block at the end of the file:

```ts
describe("escalate note to availability block", () => {
  it("creates a 7 day maintenance block starting today in Aruba; the note stays open", async () => {
    const v = await makeVehicle();
    const n = await createNote(v.id, { body: "Brakes feel soft" }, adminId);
    const { block } = await escalateNoteToBlock(n.id);
    expect(block.vehicleId).toBe(v.id);
    expect(block.type).toBe("maintenance");
    expect(block.reason).toBe("Brakes feel soft");
    const expectedStart = new Date(`${arubaToday()}T00:00:00-04:00`);
    expect(new Date(block.startAt).getTime()).toBe(expectedStart.getTime());
    expect(new Date(block.endAt).getTime() - new Date(block.startAt).getTime()).toBe(7 * 86_400_000);
    // the note stays open so the badge keeps nagging until the work is done
    const counts = await openNoteCounts();
    expect(counts.get(v.id)).toBe(1);
    // and the block is a perfectly normal availability block row
    const rows = await db.select().from(availabilityBlocks).where(eq(availabilityBlocks.vehicleId, v.id));
    expect(rows.length).toBe(1);
  });

  it("rejects an unknown note", async () => {
    await expectReject(escalateNoteToBlock("00000000-0000-0000-0000-000000000000"), /not found/i);
  });
});
```

Also add `import { eq } from "drizzle-orm";` to the test file's imports (needed by the `where` above). Note the assertions wrap `block.startAt` in `new Date(...)`: this passes whether plan 01 mapped the timestamptz columns to `Date` objects (default) or ISO strings (`mode: "string"`).

- [ ] Run the test to verify it fails: `npm test -- --no-file-parallelism src/test/vehicle-notes.test.ts`. Expected failure: the file fails to load with `SyntaxError` / export error — `escalateNoteToBlock` is not exported from `@/lib/admin/vehicle-notes`.

- [ ] Write the implementation. In `src/lib/admin/vehicle-notes.ts`, extend the schema import to `import { vehicleNotes, availabilityBlocks } from "@/lib/db/schema";`, add `import { arubaToday } from "@/lib/booking/public";` below the other imports, then append at the end of the file:

```ts
/** How long a one-tap escalation blocks the car. Staff adjust under Blocks. */
export const ESCALATION_BLOCK_DAYS = 7;

export interface EscalationResult {
  note: VehicleNote;
  block: typeof availabilityBlocks.$inferSelect;
}

/**
 * One-tap "Block car for this": turns a note into a maintenance availability
 * block starting today 00:00 Aruba (UTC-4, no DST) running ESCALATION_BLOCK_DAYS.
 * The note stays open; staff resolve it once the work is done, and the block is
 * a normal availability block they can adjust or delete under Blocks.
 */
export async function escalateNoteToBlock(noteId: string): Promise<EscalationResult> {
  const db = await getDb();
  const note = await getNote(noteId);
  if (!note) throw Errors.notFound("Note not found");
  const day = arubaToday();
  const startAt = new Date(`${day}T00:00:00-04:00`);
  const endAt = new Date(startAt.getTime() + ESCALATION_BLOCK_DAYS * 86_400_000);
  const [block] = await db.insert(availabilityBlocks).values({
    vehicleId: note.vehicleId,
    startAt,
    endAt,
    type: "maintenance",
    reason: note.body.slice(0, 200),
  }).returning();
  return { note, block: block! };
}
```

Compatibility note: if plan 01 defined `availabilityBlocks.startAt`/`endAt` with `mode: "string"`, TypeScript will reject the `Date` values in `.values({...})` — in that case pass `startAt.toISOString()` and `endAt.toISOString()` instead. The test is written to pass either way.

- [ ] Run the test to verify it passes: `npm test -- --no-file-parallelism src/test/vehicle-notes.test.ts` — 7 tests pass.

- [ ] Run the full suite: `npm test -- --no-file-parallelism` — green.

- [ ] Commit:

```
git add src/lib/admin/vehicle-notes.ts src/test/vehicle-notes.test.ts
git commit -m "feat(fleet): escalate a vehicle note to an availability block"
```

---

### Task 4: Admin API routes for notes + open-note counts on the vehicles list

**Files:**
- Create: `src/app/api/admin/vehicles/[id]/notes/route.ts`
- Create: `src/app/api/admin/notes/[id]/route.ts`
- Create: `src/app/api/admin/notes/[id]/escalate/route.ts`
- Modify: `src/app/api/admin/vehicles/route.ts` (the `GET` handler, line 10 in the pre-wave file)

**Interfaces:**
- Consumes: from Tasks 2–3 — `listNotes(vehicleId)`, `createNote(vehicleId, raw, createdBy)`, `getNote(id)`, `setNoteResolved(id, resolved)`, `escalateNoteToBlock(noteId)`, `openNoteCounts()`, `NoteCreateSchema`, `NotePatchSchema` from `@/lib/admin/vehicle-notes`. From the repo — `withRoute` from `@/lib/http/handler`; `json(data, req, opts?)` from `@/lib/http/respond`; `parseJsonBody(req, schema)` and `parseParams(input, schema)` from `@/lib/http/validate`; `read(req, fn)` and `mutate(req, action, fn)` from `@/lib/admin/guard` where `fn` receives `ctx: AdminContext` with `ctx.admin.id` (the acting admin's uuid) and mutate's `fn` returns `{ result, entity, entityId?, before?, after? }`; `listVehicles()` from `@/lib/admin/vehicles`.
- Produces (Task 8's UI consumes these endpoints; plan 08 later opts them in for staff — leave role handling at the default here):
  - `GET /api/admin/vehicles/[id]/notes` → `VehicleNote[]` newest first
  - `POST /api/admin/vehicles/[id]/notes` body `{ body: string }` → 201 `VehicleNote`, audit `admin.vehicle_note_created`
  - `PATCH /api/admin/notes/[id]` body `{ resolved: boolean }` → `VehicleNote`, audit `admin.vehicle_note_resolved` / `admin.vehicle_note_reopened`
  - `POST /api/admin/notes/[id]/escalate` (empty body) → 201 `{ note, block }`, audit `admin.vehicle_note_escalated`
  - `GET /api/admin/vehicles` rows now carry `openNotes: number` (additive)

**Steps:**

- [ ] Create `src/app/api/admin/vehicles/[id]/notes/route.ts` with exactly (this mirrors the sibling `[id]/blocks/route.ts` pattern):

```ts
import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody, parseParams } from "@/lib/http/validate";
import { read, mutate } from "@/lib/admin/guard";
import { listNotes, createNote, NoteCreateSchema } from "@/lib/admin/vehicle-notes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const GET = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  return json(await read(req, () => listNotes(id)), req);
});

export const POST = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const input = await parseJsonBody(req, NoteCreateSchema);
  const created = await mutate(req, "admin.vehicle_note_created", async (ctx) => {
    const row = await createNote(id, input, ctx.admin.id);
    return { result: row, entity: "vehicle_note", entityId: row.id, after: row };
  });
  return json(created, req, { status: 201 });
});
```

- [ ] Create `src/app/api/admin/notes/[id]/route.ts` with exactly:

```ts
import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody, parseParams } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { getNote, setNoteResolved, NotePatchSchema } from "@/lib/admin/vehicle-notes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const PATCH = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const { resolved } = await parseJsonBody(req, NotePatchSchema);
  const action = resolved ? "admin.vehicle_note_resolved" : "admin.vehicle_note_reopened";
  const updated = await mutate(req, action, async () => {
    const before = await getNote(id);
    const after = await setNoteResolved(id, resolved);
    return { result: after, entity: "vehicle_note", entityId: id, before, after };
  });
  return json(updated, req);
});
```

- [ ] Create `src/app/api/admin/notes/[id]/escalate/route.ts` with exactly:

```ts
import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { escalateNoteToBlock } from "@/lib/admin/vehicle-notes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const POST = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const result = await mutate(req, "admin.vehicle_note_escalated", async () => {
    const { note, block } = await escalateNoteToBlock(id);
    return { result: { note, block }, entity: "availability_block", entityId: block.id, after: block };
  });
  return json(result, req, { status: 201 });
});
```

- [ ] Modify `src/app/api/admin/vehicles/route.ts`: add the import `import { openNoteCounts } from "@/lib/admin/vehicle-notes";` below the existing imports, and replace the line

```ts
export const GET = withRoute(async (req) => json(await read(req, listVehicles), req));
```

with:

```ts
export const GET = withRoute(async (req) =>
  json(await read(req, async () => {
    const [rows, counts] = await Promise.all([listVehicles(), openNoteCounts()]);
    return rows.map((v) => ({ ...v, openNotes: counts.get(v.id) ?? 0 }));
  }), req));
```

Leave the `POST` handler untouched.

- [ ] Typecheck: `npx tsc --noEmit` — clean.
- [ ] Lint: `npm run lint` — clean.
- [ ] Run the full suite (route logic is thin over the lib tested in Tasks 2–3; this guards against import/wiring breakage): `npm test -- --no-file-parallelism` — green.

- [ ] Commit:

```
git add "src/app/api/admin/vehicles/[id]/notes/route.ts" "src/app/api/admin/notes" src/app/api/admin/vehicles/route.ts
git commit -m "feat(fleet): notes and escalate admin API routes; vehicles list carries open-note counts"
```

---

### Task 5: Open-note counts on the planning board data

**Files:**
- Modify: `src/lib/admin/planning.ts` (the `PlanningVehicle` interface and the `byVehicle` seeding loop inside `getPlanning`)
- Test: `src/test/planning-notes.test.ts`

**Interfaces:**
- Consumes: from Task 2 — `createNote`, `setNoteResolved`, `openNoteCounts()` from `@/lib/admin/vehicle-notes`. From the repo — `getPlanning(from: string, to: string): Promise<Planning>` in `src/lib/admin/planning.ts`, where `Planning.categories: { class: string; vehicles: PlanningVehicle[] }[]` and `PlanningVehicle` currently carries `id, name, slug, plate, class, bookings, blocks` (plans 01/02 may have added more fields — keep them all).
- Produces (Task 9 consumes): `PlanningVehicle` gains `openNotes: number` (0 when the car has no open notes), populated for every vehicle `getPlanning` returns. `GET /api/admin/planning` passes it through automatically (the route serializes `getPlanning`'s result as-is).

**Steps:**

- [ ] Write the failing test. Create `src/test/planning-notes.test.ts` with exactly:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { adminUsers } from "@/lib/db/schema";
import { createVehicle, VehicleCreateSchema } from "@/lib/admin/vehicles";
import { createNote, setNoteResolved } from "@/lib/admin/vehicle-notes";
import { getPlanning } from "@/lib/admin/planning";

const base = {
  class: "Van" as const, name: "Badge Van", seats: 9, transmission: "Manual" as const,
  doors: 4, priceDayCents: 9000, priceWeekCents: 54000, priceMonthCents: 180000,
};
let seq = 9100;

let adminId: string;

beforeAll(async () => {
  const db = await getDb();
  await runMigrations();
  const [a] = await db.insert(adminUsers).values({
    email: "planning-notes@fleetdesk.app",
    passwordHash: "$argon2id$placeholder-hash-not-a-real-credential",
  }).returning();
  adminId = a!.id;
});

describe("planning board open-note counts", () => {
  it("carries openNotes per vehicle, counting only unresolved notes", async () => {
    const noisy = await createVehicle(VehicleCreateSchema.parse({ ...base, plate: "PN-" + seq++, slug: "planning-noisy" }));
    const quiet = await createVehicle(VehicleCreateSchema.parse({ ...base, plate: "PN-" + seq++, slug: "planning-quiet" }));
    await createNote(noisy.id, { body: "AC blows warm" }, adminId);
    await createNote(noisy.id, { body: "Scratch on left door" }, adminId);
    const done = await createNote(noisy.id, { body: "Oil change due" }, adminId);
    await setNoteResolved(done.id, true);

    const planning = await getPlanning("2026-08-01", "2026-08-14");
    const flat = planning.categories.flatMap((c) => c.vehicles);
    expect(flat.find((v) => v.id === noisy.id)?.openNotes).toBe(2);
    expect(flat.find((v) => v.id === quiet.id)?.openNotes).toBe(0);
  });
});
```

- [ ] Run the test to verify it fails: `npm test -- --no-file-parallelism src/test/planning-notes.test.ts`. Expected failure: TypeScript/vitest reports `Property 'openNotes' does not exist on type 'PlanningVehicle'` (or the assertion gets `undefined` instead of `2`).

- [ ] Write the implementation in `src/lib/admin/planning.ts` (three small edits; plans 01/02 have reshaped this file — anchor on the quoted text, not line numbers):
  1. Add the import below the existing imports:

```ts
import { openNoteCounts } from "@/lib/admin/vehicle-notes";
```

  2. In the `PlanningVehicle` interface, add one field after `class: string;`:

```ts
  openNotes: number;
```

  3. Inside `getPlanning`, next to the other data queries (the `vehicleRows` / `bookingRows` / `blockRows` fetches), add:

```ts
  const noteCounts = await openNoteCounts();
```

  and in the vehicle seeding loop — the statement that today reads `byVehicle.set(v.id, { id: v.id, name: v.name, slug: v.slug, plate: v.plate, class: v.class, bookings: [], blocks: [] });` — add `openNotes: noteCounts.get(v.id) ?? 0,` to the object literal (keep every other property the loop already sets):

```ts
    byVehicle.set(v.id, { id: v.id, name: v.name, slug: v.slug, plate: v.plate, class: v.class, openNotes: noteCounts.get(v.id) ?? 0, bookings: [], blocks: [] });
```

- [ ] Run the test to verify it passes: `npm test -- --no-file-parallelism src/test/planning-notes.test.ts` — 1 test passes.
- [ ] Run the full suite (the planning tests from earlier plans must still pass with the extra field): `npm test -- --no-file-parallelism` — green.
- [ ] Typecheck: `npx tsc --noEmit` — clean.

- [ ] Commit:

```
git add src/lib/admin/planning.ts src/test/planning-notes.test.ts
git commit -m "feat(planning): open-note counts on planning vehicles"
```

---

### Task 6: Fleet form fields for make, model, year, color with auto-composed name

**Files:**
- Modify: `src/app/admin/(shell)/fleet/page.tsx` (the `Vehicle` interface, the `empty` form object, `save()`, `edit()`, and the Modal form grid)

**Interfaces:**
- Consumes: Task 1's API contract — `POST /api/admin/vehicles` and `PATCH /api/admin/vehicles/[id]` accept optional/nullable `make` (string ≤60), `model` (string ≤60), `year` (int 1950–2100), `color` (string ≤40); vehicle rows come back with `make: string | null; model: string | null; year: number | null; color: string | null`. Existing page plumbing: `api`, `apiPatch`, `apiGet` from `../../client`; `Modal`, `useToast` from `@/app/admin/_ui`; `Select` from `@/components/ui`.
- Produces: the page-local `Vehicle` interface carries the four identity fields (Task 7's search consumes `v.make` / `v.model`). Name auto-compose behavior: while the admin has not typed a custom name, name = "make model" (single-spaced, trimmed); typing in the Name field stops auto-compose; clearing the Name field resumes it.

**Steps (UI task — implement, typecheck, manual verify, commit):**

- [ ] In `src/app/admin/(shell)/fleet/page.tsx`, make these edits (plan 03 added compliance fields to this file — keep every field and cell it added; the edits below are purely additive):

  1. In the page-local `interface Vehicle`, after `class: string; name: string;` add:

```ts
  make: string | null; model: string | null; year: number | null; color: string | null;
```

  2. Above the component (next to the `CLASSES` const), add the compose helper:

```ts
const composeName = (make: string, model: string) => `${make} ${model}`.replace(/\s+/g, " ").trim();
```

  3. In the `empty` form-state object, add these entries (all form values are strings, matching the file's convention; `nameTouched` tracks whether auto-compose is paused):

```ts
  make: "", model: "", year: "", color: "", nameTouched: false,
```

  4. Inside the `FleetPage` component (below the `openAdd` function), add the identity change handler:

```ts
  function setIdentity(field: "make" | "model", value: string) {
    setF((prev) => {
      const next = { ...prev, [field]: value };
      if (!prev.nameTouched) next.name = composeName(next.make, next.model);
      return next;
    });
  }
```

  5. In `save()`, extend the `body` object with (place after `name: f.name,`):

```ts
      make: f.make.trim() === "" ? null : f.make.trim(),
      model: f.model.trim() === "" ? null : f.model.trim(),
      year: f.year.trim() === "" ? null : Number(f.year),
      color: f.color.trim() === "" ? null : f.color.trim(),
```

  6. In `edit(v)`, extend the object passed to `setF` with:

```ts
      make: v.make ?? "", model: v.model ?? "",
      year: v.year === null ? "" : v.year.toString(),
      color: v.color ?? "",
      nameTouched: v.name !== composeName(v.make ?? "", v.model ?? ""),
```

  (a legacy car whose name was typed by hand keeps it: composed of null/null is `""` which never equals a real name, so `nameTouched` is true and auto-compose stays off.)

  7. In the Modal's form grid, replace the current Name field

```tsx
<label>Name<input data-autofocus required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
```

  with this block (Make takes the autofocus; Name moves after the identity fields and toggles `nameTouched`):

```tsx
<label>Make<input data-autofocus value={f.make} onChange={(e) => setIdentity("make", e.target.value)} placeholder="Kia" /></label>
<label>Model<input value={f.model} onChange={(e) => setIdentity("model", e.target.value)} placeholder="Picanto" /></label>
<label>Year<input type="number" min="1950" max="2100" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })} placeholder="2023" /></label>
<label>Color<input value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} placeholder="White" /></label>
<label>Name (shown to customers)<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, nameTouched: e.target.value !== "" })} /></label>
```

- [ ] Typecheck: `npx tsc --noEmit` — clean. Lint: `npm run lint` — clean.

- [ ] Manual verification (make sure no `npm run build` is running): start `npm run dev`, log into the admin at `http://localhost:3000/admin` (dev admin credentials), open `http://localhost:3000/admin/fleet`, click "Add vehicle" and check:
  - Typing Make "Kia" then Model "Picanto" live-fills Name to "Kia Picanto".
  - Overtyping Name to "Kia Picanto GT" stops the auto-fill (change Model — Name stays put).
  - Clearing Name entirely resumes the auto-fill on the next Make/Model keystroke.
  - Saving with Year 2023 and Color White, then reopening Edit, shows all four fields populated; clearing Color and saving stores null (field comes back empty).
  Stop the dev server when done.

- [ ] Commit:

```
git add "src/app/admin/(shell)/fleet/page.tsx"
git commit -m "feat(fleet): vehicle form captures make, model, year and color with auto-composed name"
```

---

### Task 7: Fleet list grouped by class with sticky headers, search and class chips

**Files:**
- Modify: `src/app/admin/(shell)/fleet/page.tsx` (the vehicles table rendering)
- Modify: `src/app/admin/(shell)/fleet/fleet.css` (append styles)

**Interfaces:**
- Consumes: Task 6's page-local `Vehicle` interface (`v.make`, `v.model` are `string | null`); the existing `CLASSES` const in this file (`["Economy", "Compact", "SUV", "4x4", "Van"]` — this IS the CLASS_ORDER the spec names); existing `vehicles` state and `loading` flag.
- Produces: grouped, filterable fleet list. Task 8 adds badges and a Notes action into the row JSX this task moves — do not change row cell content here, only the wrapping structure.

**Steps (UI task — implement, typecheck, manual verify, commit):**

- [ ] In `src/app/admin/(shell)/fleet/page.tsx`:

  1. Extend the React import to include `useMemo` and `Fragment`:

```ts
import { Fragment, useEffect, useMemo, useState, type FormEvent } from "react";
```

  2. Next to the `CLASSES` const add:

```ts
const SPAN_ALL = 99; // colSpan that always covers every column, even ones other plans add
```

  3. Inside `FleetPage`, below the existing state declarations, add:

```ts
  const [q, setQ] = useState("");
  const [classFilter, setClassFilter] = useState<string | null>(null);

  const visibleVehicles = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return vehicles.filter((v) => {
      if (classFilter && v.class !== classFilter) return false;
      if (!needle) return true;
      return [v.plate, v.name, v.make ?? "", v.model ?? ""].some((s) => s.toLowerCase().includes(needle));
    });
  }, [vehicles, q, classFilter]);

  const groups = useMemo(() => {
    const order = (c: string) => { const i = CLASSES.indexOf(c); return i < 0 ? 99 : i; };
    const classes = [...new Set(visibleVehicles.map((v) => v.class))].sort((a, b) => order(a) - order(b));
    return classes.map((cls) => ({ class: cls, vehicles: visibleVehicles.filter((v) => v.class === cls) }));
  }, [visibleVehicles]);
```

  4. Directly below the `fleet-panel-head` div (before the loading/table branch), render the filter bar only when there is something to filter:

```tsx
        {!loading && vehicles.length > 0 && (
          <div className="fleet-filters">
            <input
              type="search"
              className="fleet-search"
              placeholder="Search plate, make, model or name"
              aria-label="Search vehicles"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="fleet-chips" role="group" aria-label="Filter by class">
              <button type="button" className={`fleet-chip ${classFilter === null ? "is-on" : ""}`} onClick={() => setClassFilter(null)}>All</button>
              {CLASSES.map((c) => (
                <button key={c} type="button" className={`fleet-chip ${classFilter === c ? "is-on" : ""}`} onClick={() => setClassFilter(classFilter === c ? null : c)}>{c}</button>
              ))}
            </div>
          </div>
        )}
```

  5. Rework ONLY the `<tbody>` of the loaded vehicles table. Today it reads `{vehicles.map((v) => ( <tr key={v.id}> ...cells... </tr> ))}`. Replace it with the grouped structure below, moving the existing `<tr key={v.id}> ... </tr>` JSX VERBATIM (including any cells plan 03 added) into the inner map. The row shown here is the pre-plan-03 baseline for reference; if your checkout's row has more cells, keep them exactly:

```tsx
            <tbody>
              {groups.length === 0 ? (
                <tr><td colSpan={SPAN_ALL} className="muted">No cars match. Try a different search or clear the class filter.</td></tr>
              ) : groups.map((g) => (
                <Fragment key={g.class}>
                  <tr className="fleet-group-row">
                    <td colSpan={SPAN_ALL}>{g.class}<span className="fleet-group-count">{g.vehicles.length} {g.vehicles.length === 1 ? "car" : "cars"}</span></td>
                  </tr>
                  {g.vehicles.map((v) => (
                    <tr key={v.id}>
                      <td><b>{v.plate}</b></td>
                      <td>{v.name}<div className="fleet-slug">{v.slug}</div></td>
                      <td>{v.class}</td>
                      <td className="num">{money(v.priceDayCents)}</td>
                      <td className="num">{money(v.priceWeekCents)}</td>
                      <td className="num">{money(v.priceMonthCents)}</td>
                      <td className="num">{v.depositCents === null ? "TBC" : money(v.depositCents)}</td>
                      <td><span className={`tag ${statusTag(v.status)}`}>{v.status}</span></td>
                      <td className="fleet-actions"><div className="row-actions">
                        <button onClick={() => edit(v)}>Edit</button>
                        <button onClick={() => openBlocks(v)}>Blocks</button>
                        {v.status !== "retired" && <button className="danger" onClick={() => retire(v)}>Retire</button>}
                      </div></td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
```

  The empty-fleet `EmptyState` branch and the skeleton branch stay exactly as they are.

- [ ] Append to `src/app/admin/(shell)/fleet/fleet.css`:

```css
/* Search + class filter chips above the vehicles table. */
.fleet-filters {
  display: flex;
  align-items: center;
  gap: .9rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}
.fleet-search {
  flex: 1 1 220px;
  max-width: 340px;
  padding: .5rem .8rem;
  border: 1.5px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
  color: var(--ink);
  font: inherit;
}
.fleet-search:focus { outline: none; border-color: var(--teal); box-shadow: 0 0 0 3px rgba(14,58,64,.12); }
.fleet-chips { display: flex; gap: .4rem; flex-wrap: wrap; }
.fleet-chip {
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink-soft);
  font-family: var(--font-mono);
  font-size: .7rem;
  letter-spacing: .04em;
  padding: .3rem .7rem;
  border-radius: 999px;
  cursor: pointer;
}
.fleet-chip:hover { border-color: var(--teal); color: var(--ink); }
.fleet-chip.is-on { background: var(--teal); border-color: var(--teal); color: var(--sand); }

/* Class group header rows: sticky while their group scrolls under them. */
.fleet-group-row td {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--sand-2);
  font-family: var(--font-mono);
  font-size: .72rem;
  font-weight: 600;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--ink-soft);
  padding: .45rem .75rem;
}
.fleet-group-row .fleet-group-count {
  margin-left: .6rem;
  color: var(--ink-mute);
  font-weight: 400;
  letter-spacing: .02em;
  text-transform: none;
}
```

- [ ] Typecheck: `npx tsc --noEmit` — clean. Lint: `npm run lint` — clean.

- [ ] Manual verification: `npm run dev`, open `http://localhost:3000/admin/fleet` with several vehicles across classes (seed if needed: `npm run db:seed`). Check:
  - Rows are grouped Economy → Compact → SUV → 4x4 → Van with an uppercase group header row per class showing the car count.
  - Scrolling a long list keeps the current group header pinned at the top of the viewport until the next one pushes it away.
  - Typing "picanto" in the search filters to matching make/model/name/plate rows across groups; a nonsense query shows "No cars match. Try a different search or clear the class filter."
  - Clicking the "SUV" chip shows only SUVs; clicking it again clears the filter; "All" clears it too.
  Stop the dev server when done.

- [ ] Commit:

```
git add "src/app/admin/(shell)/fleet/page.tsx" "src/app/admin/(shell)/fleet/fleet.css"
git commit -m "feat(fleet): fleet list grouped by class with sticky headers, search and class chips"
```

---

### Task 8: Notes drawer, fleet row badges and one-tap escalate

**Files:**
- Modify: `src/app/admin/(shell)/fleet/page.tsx` (add notes state, drawer, badges, actions)
- Modify: `src/app/admin/(shell)/fleet/fleet.css` (append styles)

**Interfaces:**
- Consumes: Task 4's endpoints — `GET /api/admin/vehicles` rows include `openNotes: number`; `GET /api/admin/vehicles/[id]/notes` → array of `{ id: string; body: string; createdBy: string | null; createdAt: string; resolvedAt: string | null }` newest first; `POST /api/admin/vehicles/[id]/notes` body `{ body }`; `PATCH /api/admin/notes/[id]` body `{ resolved: boolean }`; `POST /api/admin/notes/[id]/escalate` (empty JSON body) blocks the car for 7 days. Existing page plumbing: `apiGet`, `api`, `apiPatch`, `toast`, `confirm`, `Drawer` from `@/app/admin/_ui`, the `load()` refresher.
- Produces: complete per-car notes UX (spec: add, list newest-first, resolve, badge on the row, escalate in one tap).

**Steps (UI task — implement, typecheck, manual verify, commit):**

- [ ] In `src/app/admin/(shell)/fleet/page.tsx`:

  1. Add `openNotes` to the page-local `Vehicle` interface (after the Task 6 identity fields):

```ts
  openNotes: number;
```

  2. Below the `interface Block ...` line, add:

```ts
interface Note { id: string; body: string; createdAt: string; resolvedAt: string | null }
```

  3. Inside `FleetPage`, next to the blocks-drawer state, add:

```ts
  const [notesFor, setNotesFor] = useState<Vehicle | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteBody, setNoteBody] = useState("");
```

  4. Below the `removeBlock` function, add the notes handlers:

```ts
  async function openNotes(v: Vehicle) {
    setNotesFor(v);
    setNotes(await apiGet<Note[]>(`/api/admin/vehicles/${v.id}/notes`));
  }
  async function refreshNotes(vehicleId: string) {
    setNotes(await apiGet<Note[]>(`/api/admin/vehicles/${vehicleId}/notes`));
    await load(); // badge counts on the rows come from the vehicles list
  }
  async function addNote(e: FormEvent) {
    e.preventDefault();
    if (!notesFor) return;
    try {
      await api(`/api/admin/vehicles/${notesFor.id}/notes`, { body: noteBody });
      setNoteBody("");
      await refreshNotes(notesFor.id);
      toast.show({ type: "success", message: "Note added." });
    } catch (err) { toast.show({ type: "error", message: (err as ApiError).message }); }
  }
  async function resolveNote(n: Note, resolved: boolean) {
    if (!notesFor) return;
    try {
      await apiPatch(`/api/admin/notes/${n.id}`, { resolved });
      await refreshNotes(notesFor.id);
      toast.show({ type: "success", message: resolved ? "Note resolved." : "Note reopened." });
    } catch (err) { toast.show({ type: "error", message: (err as ApiError).message }); }
  }
  async function escalateNote(n: Note) {
    if (!notesFor) return;
    const ok = await confirm({
      title: "Block this car?",
      message: `${notesFor.plate} gets a 7 day maintenance block starting today for: "${n.body}". You can adjust or remove it under Blocks. The note stays open until you resolve it.`,
      confirmLabel: "Block car",
    });
    if (!ok) return;
    try {
      await api(`/api/admin/notes/${n.id}/escalate`, {});
      await refreshNotes(notesFor.id);
      toast.show({ type: "success", message: "Car blocked for 7 days. Adjust it under Blocks if needed." });
    } catch (err) { toast.show({ type: "error", message: (err as ApiError).message }); }
  }
```

  5. In the vehicle row JSX (inside the grouped `g.vehicles.map` from Task 7):
     - Change the plate cell from `<td><b>{v.plate}</b></td>` to:

```tsx
<td><b>{v.plate}</b>{v.openNotes > 0 && <span className="fleet-note-badge" title={`${v.openNotes} open ${v.openNotes === 1 ? "note" : "notes"}`}>{v.openNotes}</span>}</td>
```

     - In the `row-actions` div, add a Notes button between Edit and Blocks:

```tsx
<button onClick={() => openNotes(v)}>Notes</button>
```

  6. Below the existing blocks `<Drawer ...>` element, add the notes drawer:

```tsx
      <Drawer
        open={notesFor !== null}
        onClose={() => setNotesFor(null)}
        title="Notes"
        description={notesFor ? `${notesFor.plate} · ${notesFor.name}` : undefined}
        size="md"
        footer={<button type="button" className="btn btn--quiet" onClick={() => setNotesFor(null)}>Close</button>}
      >
        <form className="inline-form fleet-note-form" onSubmit={addNote}>
          <label>New note<br />
            <input data-autofocus required maxLength={500} value={noteBody} onChange={(e) => setNoteBody(e.target.value)} placeholder="e.g. customer says brakes feel soft" />
          </label>
          <button className="btn" style={{ width: "auto" }}>Add note</button>
        </form>
        {notes.length === 0 ? (
          <p className="muted">No notes for this car yet. Complaints and future maintenance go here.</p>
        ) : (
          <ul className="fleet-notes">
            {notes.map((n) => (
              <li key={n.id} className={`fleet-note ${n.resolvedAt ? "is-resolved" : ""}`}>
                <p className="fleet-note__body">{n.body}</p>
                <div className="fleet-note__meta">
                  <span>{new Date(n.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                  {n.resolvedAt ? <span className="tag on">resolved</span> : <span className="tag def">open</span>}
                </div>
                <div className="row-actions">
                  {n.resolvedAt === null ? (
                    <>
                      <button onClick={() => resolveNote(n, true)}>Resolve</button>
                      <button onClick={() => escalateNote(n)}>Block car for this</button>
                    </>
                  ) : (
                    <button onClick={() => resolveNote(n, false)}>Reopen</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Drawer>
```

- [ ] Append to `src/app/admin/(shell)/fleet/fleet.css`:

```css
/* Open-note count badge on the plate cell. */
.fleet-note-badge {
  display: inline-block;
  min-width: 1.15rem;
  margin-left: .45rem;
  padding: .05rem .3rem;
  border-radius: 999px;
  background: var(--amber-bg);
  color: var(--amber);
  font-family: var(--font-mono);
  font-size: .68rem;
  font-weight: 600;
  text-align: center;
  vertical-align: middle;
}

/* Notes drawer: add form on top, note cards below. */
.fleet-note-form { margin-bottom: 1.1rem; }
.fleet-note-form label { flex: 1 1 220px; }
.fleet-note-form input { width: 100%; }
.fleet-notes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .75rem; }
.fleet-note { border: 1px solid var(--line); border-radius: 12px; padding: .75rem .9rem; background: var(--panel); }
.fleet-note.is-resolved { opacity: .62; }
.fleet-note__body { margin: 0 0 .4rem; }
.fleet-note__meta {
  display: flex;
  align-items: center;
  gap: .6rem;
  font-size: .72rem;
  color: var(--ink-mute);
  font-family: var(--font-mono);
  margin-bottom: .45rem;
}
.fleet-note .row-actions { justify-content: flex-start; }
```

- [ ] Typecheck: `npx tsc --noEmit` — clean. Lint: `npm run lint` — clean.

- [ ] Manual verification: `npm run dev`, open `http://localhost:3000/admin/fleet`:
  - Click "Notes" on a car, add "Customer says brakes feel soft" — it appears on top with an "open" tag, and after the drawer refresh the row's plate cell shows an amber badge with count 1 (hover shows "1 open note").
  - Add a second note — badge shows 2, newest note listed first.
  - Resolve one — it dims with a "resolved" tag, badge drops to 1; Reopen brings it back.
  - Click "Block car for this" on the open note — confirm dialog names the plate and the note; after confirming, a success toast appears and the car shows a 7 day maintenance block starting today under "Blocks" (and on the planning board at `http://localhost:3000/admin`). The note stays open.
  Stop the dev server when done.

- [ ] Run the full suite once more: `npm test -- --no-file-parallelism` — green.

- [ ] Commit:

```
git add "src/app/admin/(shell)/fleet/page.tsx" "src/app/admin/(shell)/fleet/fleet.css"
git commit -m "feat(fleet): notes drawer with add, resolve, block-car escalation and row badges"
```

---

### Task 9: Open-note badge on planning board vehicle labels

**Files:**
- Modify: `src/app/admin/(shell)/page.tsx` (the page-local `Vehicle` interface and the `pl-label` element)
- Modify: `src/app/admin/(shell)/dashboard.css` (append one rule)

**Interfaces:**
- Consumes: Task 5's seam — `GET /api/admin/planning` vehicles now include `openNotes: number` (the route serializes `getPlanning()` as-is). Existing markup: each planning row renders its label as `<div className="pl-label"><b>{v.plate}</b><small>{v.name}</small></div>` (plans 01/02 reshaped other parts of this page; find the label by this quoted JSX, not by line number). Shared CSS gives `.pl-label` a sticky flex-column layout and styles `.pl-label b` / `.pl-label small` (`src/app/admin/admin.css` lines 233–236).
- Produces: spec Workstream 6 item "open-note count badge ... on the planning-board vehicle label (tooltip)".

**Steps (UI task — implement, typecheck, manual verify, commit):**

- [ ] In `src/app/admin/(shell)/page.tsx`:

  1. In the page-local `interface Vehicle { id: string; name: string; slug: string; plate: string; class: string; bookings: Bar[]; blocks: Block[] }`, add after `class: string;`:

```ts
  openNotes: number;
```

  2. Replace the label element

```tsx
<div className="pl-label"><b>{v.plate}</b><small>{v.name}</small></div>
```

  with:

```tsx
<div className="pl-label"><b>{v.plate}{v.openNotes > 0 && <span className="pl-note-badge" title={`${v.openNotes} open ${v.openNotes === 1 ? "note" : "notes"}`}>{v.openNotes}</span>}</b><small>{v.name}</small></div>
```

  (the badge sits inside the `<b>` so it stays on the plate line of the flex-column label.)

- [ ] Append to `src/app/admin/(shell)/dashboard.css`:

```css
/* Open-note count badge next to the plate on the vehicle label. */
.pl-note-badge {
  display: inline-block;
  min-width: 1.05rem;
  margin-left: .4rem;
  padding: .02rem .28rem;
  border-radius: 999px;
  background: var(--amber-bg);
  color: var(--amber);
  font-family: var(--font-mono);
  font-size: .62rem;
  font-weight: 600;
  text-align: center;
  vertical-align: middle;
}
```

- [ ] Typecheck: `npx tsc --noEmit` — clean. Lint: `npm run lint` — clean.

- [ ] Manual verification: `npm run dev`, open `http://localhost:3000/admin`. A car that got notes in Task 8 shows a small amber count badge right of its plate in the left label column; hovering it shows "N open notes"; cars without open notes show no badge. Resolving all notes for the car under Fleet → Notes and reloading the board removes the badge. Stop the dev server when done.

- [ ] Run the full suite one final time: `npm test -- --no-file-parallelism` — green.

- [ ] Commit:

```
git add "src/app/admin/(shell)/page.tsx" "src/app/admin/(shell)/dashboard.css"
git commit -m "feat(planning): open-note badge on planning board vehicle labels"
```

---

## Done means

- `vehicles` has nullable `make`/`model`/`year`/`color`; the form captures them and auto-composes (but never forces) `name`.
- Fleet list: grouped by CLASS_ORDER with sticky class headers, live search over plate/make/model/name, class filter chips.
- `vehicle_notes` exists per the seams doc; notes drawer supports add/list-newest-first/resolve/reopen; open-note badges on fleet rows and planning labels; "Block car for this" creates a 7 day maintenance availability block via one tap plus confirm.
- All mutations audit-logged via `mutate` (`admin.vehicle_note_created` / `_resolved` / `_reopened` / `_escalated`).
- `npm test -- --no-file-parallelism` green including the three new test files; `npx tsc --noEmit` and `npm run lint` clean.
