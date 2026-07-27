# Staff Logins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every staff person gets their own 6-digit login code so the audit trail shows who did what, with the owner managing staff from a new `/admin/staff` page and staff sessions scoped to a fixed capability list.

**Architecture:** Staff accounts are ordinary `admin_users` rows with `role='staff'`, a hashed personal code, and the demo-admin trick (mfaEnabled=true with a throwaway TOTP secret) so the existing mandatory-MFA guard admits them without touching its logic. A new `POST /api/admin/auth/staff-login` route exchanges a valid code for a normal admin session bound to that person; a shared 5-fail 15-minute lockout plus the auth-tier rate limit defend the small code space. Route-level `roles` opt-ins (already supported by `read`/`mutate`/`requireAdmin`) open exactly the staff capability list; everything else stays owner-only by the existing deny-by-default.

**Tech Stack:** Next.js 15 App Router (route handlers with `withRoute`), Drizzle ORM (PGlite dev/test, Supabase Postgres prod), zod at every boundary, node:crypto sha256 (same pattern as `login_tokens.codeHash`), Sand & Surf admin UI kit (`@/app/admin/_ui`), vitest.

**Repo root:** `/Users/monischahieroms/Desktop/SaltyCode/04-Products/saltycodestudio-products/fleetdesk` (all paths below are relative to it). Work happens on branch `feat/wave-2026-07`. Plans 01-07 of this wave are already merged when this plan executes; their routes (extend, inspections, uploads, compliance, vehicle notes) exist.

## Global Constraints

- Tests: `npm test -- --no-file-parallelism` (vitest). New features land with tests.
- NEVER `npm run build` while a `next dev` server is running (shared `.next` corrupts).
- Migrations: `npm run db:generate` for drizzle diffs; hand-written SQL files in `./drizzle` for constraints/enum surgery (precedent: 0002, 0007, 0010). Applied with `npm run db:migrate`. Must work on BOTH PGlite (`pglite://`, dev/test) and Postgres (Supabase prod).
- Admin mutations go through `mutate(req, action, fn)` from `src/lib/admin/guard.ts` (audit-logged); reads through `read(req, fn)`.
- Admin UI: reuse `Modal, Drawer, useToast, useConfirm, Skeleton, EmptyState, registerPaletteAction` from `@/app/admin/_ui` and `DatePicker, Select` from `@/components/ui`. Strict CSP: no external assets ever. Money is integer cents.
- Copy: dash-free house style (no em-dashes), warm/human tone.
- Timezone: operator-local day logic uses `America/Aruba` (existing `arubaToday()` precedent).
- Design principle: less clicking. One click from a planning bar opens the BookingDrawer with everything in it.

Workstream-8 specific constraints (from the spec):

- Staff CAN: planning board, create/move bookings, check-in/check-out (inspection routes), extensions (desk + link), vehicle notes, view fleet, compliance read, uploads.
- Staff CANNOT: settings, pricing edits, refunds, reports, staff management, policies, audit log. Owner-only stays the default; only the listed routes opt in.
- The owner keeps full password + TOTP login, untouched.
- Codes are stored hashed only (sha256, `login_tokens.codeHash` pattern), shown exactly once, never audit-logged, never logged.
- Audit action `admin.login` is written on every successful login, both the owner path (after TOTP) and the staff code path.
- Accepted trade-off (recorded in the spec): a 6-digit code is weaker than password + TOTP; acceptable because staff scope excludes money movement and settings, and rate limiting + lockout + instant revocation apply.

---

### Task 1: admin_users staff columns (schema + migration)

**Files:**
- Modify: `src/lib/db/schema/admin.ts` (the `adminUsers` table, currently lines 9-27)
- Create: next drizzle migration via `npm run db:generate` (do NOT hardcode a number; drizzle-kit picks the next index and registers it in `drizzle/meta/_journal.json` itself)
- Test: `src/test/staff-schema.test.ts` (new)

**Interfaces:**
- Consumes: existing `adminUsers` table in `src/lib/db/schema/admin.ts`; `runMigrations` from `@/lib/db/migrate`; `getDb` from `@/lib/db/client`.
- Produces (seam names, verbatim from SEAMS-2026-07-wave.md "admin_users (modified in 08)"):
  - `loginCodeHash` → `login_code_hash` text nullable
  - `codeFailedAttempts` → `code_failed_attempts` smallint NOT NULL default 0
  - `codeLockedUntil` → `code_locked_until` timestamptz nullable
  - `active` → `active` boolean NOT NULL default true
  - Plus one LOCAL addition (allowed by the seams rule "if a plan needs something not listed here, it defines it locally"): `name` → `name` text nullable, the display label for staff people (staff have no real email; owners fall back to email in UI labels).

**Steps:**

- [ ] Write the failing test at `src/test/staff-schema.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { adminUsers } from "@/lib/db/schema";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
});

describe("admin_users staff columns", () => {
  it("stores staff login fields with correct defaults", async () => {
    const [row] = await db.insert(adminUsers).values({
      email: "staff-schema@staff.local",
      passwordHash: "x",
      role: "staff",
      name: "Maya",
      loginCodeHash: "abc123",
    }).returning();
    expect(row!.name).toBe("Maya");
    expect(row!.loginCodeHash).toBe("abc123");
    expect(row!.codeFailedAttempts).toBe(0);
    expect(row!.codeLockedUntil).toBeNull();
    expect(row!.active).toBe(true);
  });

  it("leaves owner rows unaffected: active defaults true, code fields null", async () => {
    const [row] = await db.insert(adminUsers).values({
      email: "owner-schema@fleetdesk.app",
      passwordHash: "x",
    }).returning();
    expect(row!.active).toBe(true);
    expect(row!.loginCodeHash).toBeNull();
    expect(row!.name).toBeNull();
  });
});
```

- [ ] Run the test to verify it fails: `npm test -- --no-file-parallelism src/test/staff-schema.test.ts` — expected failure: assertion errors such as `expected undefined to be 'Maya'` (drizzle silently drops the unknown `name`/`loginCodeHash` keys because the columns do not exist in the schema yet). A TypeScript typecheck would also flag the unknown keys.
- [ ] Edit `src/lib/db/schema/admin.ts`. First the import line (line 1):

```ts
import { pgTable, pgEnum, text, integer, boolean, smallint, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
```

Then insert the new columns inside the `adminUsers` table, directly after the `mfaLockedUntil` line (currently line 24, `mfaLockedUntil: timestamp("mfa_locked_until", { withTimezone: true }),`) and before `createdAt`:

```ts
  // Staff logins (feature wave workstream 8). A staff person signs in with a
  // personal 6-digit code stored ONLY as sha256("staff-code:" + code), same
  // hashing pattern as login_tokens.codeHash. `name` labels the person in UI
  // and audit views (staff rows carry a synthesized placeholder email).
  // The lockout pair defends the small code space: wrong codes cannot be
  // pinned on one row, so failures count against every active staff row and
  // the whole staff-code path locks after the threshold (see
  // src/lib/auth/staff-login.ts). `active=false` is instant revocation.
  name: text("name"),
  loginCodeHash: text("login_code_hash"),
  codeFailedAttempts: smallint("code_failed_attempts").notNull().default(0),
  codeLockedUntil: timestamp("code_locked_until", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
```

- [ ] Generate the migration: `npm run db:generate` — expect a new SQL file in `./drizzle` (next number after whatever plans 01-07 left; do not rename it) containing exactly these statements:

```sql
ALTER TABLE "admin_users" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "login_code_hash" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "code_failed_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "code_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "active" boolean DEFAULT true NOT NULL;
```

If the generated file contains anything else (unexpected diffs from another table), STOP: the working tree is dirty from an unfinished earlier plan; report instead of committing.
- [ ] Run the test to verify it passes: `npm test -- --no-file-parallelism src/test/staff-schema.test.ts` — expect `2 passed`.
- [ ] Typecheck: `npx tsc --noEmit` — expect no errors.
- [ ] Commit:

```bash
git add src/lib/db/schema/admin.ts drizzle src/test/staff-schema.test.ts
git commit -m "feat(staff): admin_users staff login columns (code hash, lockout, active, name)"
```

---

### Task 2: Staff account management lib (create, list, regenerate, deactivate)

**Files:**
- Create: `src/lib/admin/staff.ts`
- Test: `src/test/admin-staff.test.ts` (new)

**Interfaces:**
- Consumes:
  - `adminUsers` from `@/lib/db/schema` (with Task 1 columns `name`, `loginCodeHash`, `codeFailedAttempts`, `codeLockedUntil`, `active`).
  - `hashPassword(plain: string): Promise<string>` from `@/lib/auth/password`.
  - `encryptField(plaintext: string, aad: string): Buffer` from `@/lib/crypto/fields` (AAD convention `admin_users:${id}:totp_secret`, exactly as `src/lib/auth/demo.ts` line 53 does).
  - `destroyAllForSubject(subjectType: "admin" | "customer", subjectId: string): Promise<void>` from `@/lib/auth/sessions`.
  - `Errors` from `@/lib/http/errors`.
- Produces (consumed by Tasks 3, 5):
  - `hashStaffCode(code: string): string` — sha256 hex of `"staff-code:" + code`.
  - `listStaff(): Promise<StaffListRow[]>` with `StaffListRow = { id: string; name: string | null; active: boolean; createdAt: Date }`.
  - `createStaff(name: string): Promise<{ id: string; name: string; code: string }>` — the plaintext `code` is returned exactly once, never stored.
  - `regenerateStaffCode(id: string): Promise<{ code: string }>`.
  - `setStaffActive(id: string, active: boolean): Promise<{ id: string; active: boolean }>`.

**Steps:**

- [ ] Write the failing test at `src/test/admin-staff.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { adminUsers, sessions } from "@/lib/db/schema";
import { createSession } from "@/lib/auth/sessions";
import {
  createStaff, listStaff, regenerateStaffCode, setStaffActive, hashStaffCode,
} from "@/lib/admin/staff";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
});

describe("staff account management", () => {
  it("creates a staff member with a one-time 6-digit code stored only as a hash", async () => {
    const created = await createStaff("Maya");
    expect(created.code).toMatch(/^\d{6}$/);
    expect(created.name).toBe("Maya");
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, created.id));
    expect(row!.role).toBe("staff");
    expect(row!.name).toBe("Maya");
    expect(row!.active).toBe(true);
    // Demo-admin pattern: MFA "enrolled" so the mandatory-MFA guard admits the
    // session; the throwaway secret is never verified.
    expect(row!.mfaEnabled).toBe(true);
    expect(row!.totpSecretEnc).not.toBeNull();
    expect(row!.loginCodeHash).toBe(hashStaffCode(created.code));
    expect(row!.loginCodeHash).not.toContain(created.code);
    expect(row!.email).toBe(`staff-${created.id}@staff.local`);
  });

  it("lists staff accounts only, owners excluded", async () => {
    const [owner] = await db.insert(adminUsers).values({
      email: "roster-owner@fleetdesk.app", passwordHash: "x",
    }).returning();
    const staff = await createStaff("Rey");
    const roster = await listStaff();
    const ids = roster.map((r) => r.id);
    expect(ids).toContain(staff.id);
    expect(ids).not.toContain(owner!.id);
    const rey = roster.find((r) => r.id === staff.id)!;
    expect(rey).toMatchObject({ name: "Rey", active: true });
    expect(rey.createdAt).toBeInstanceOf(Date);
  });

  it("regenerating replaces the code and revokes existing sessions", async () => {
    const created = await createStaff("Nia");
    await createSession({ subjectType: "admin", subjectId: created.id });
    const regen = await regenerateStaffCode(created.id);
    expect(regen.code).toMatch(/^\d{6}$/);
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, created.id));
    expect(row!.loginCodeHash).toBe(hashStaffCode(regen.code));
    // The uniqueness check clashes against the row's own current hash, so the
    // regenerated code is guaranteed different from the old one.
    expect(row!.loginCodeHash).not.toBe(hashStaffCode(created.code));
    expect(row!.codeFailedAttempts).toBe(0);
    expect(row!.codeLockedUntil).toBeNull();
    const live = await db.select().from(sessions).where(eq(sessions.subjectId, created.id));
    expect(live).toHaveLength(0);
  });

  it("deactivating revokes sessions, reactivating restores access flag", async () => {
    const created = await createStaff("Odin");
    await createSession({ subjectType: "admin", subjectId: created.id });
    const off = await setStaffActive(created.id, false);
    expect(off).toEqual({ id: created.id, active: false });
    const live = await db.select().from(sessions).where(eq(sessions.subjectId, created.id));
    expect(live).toHaveLength(0);
    const on = await setStaffActive(created.id, true);
    expect(on).toEqual({ id: created.id, active: true });
  });

  it("refuses to manage an owner account through the staff API", async () => {
    const [owner] = await db.insert(adminUsers).values({
      email: "protected-owner@fleetdesk.app", passwordHash: "x",
    }).returning();
    await expect(regenerateStaffCode(owner!.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(setStaffActive(owner!.id, false)).rejects.toMatchObject({ code: "not_found" });
  });
});
```

- [ ] Run the test to verify it fails: `npm test -- --no-file-parallelism src/test/admin-staff.test.ts` — expected failure: `Cannot find module '@/lib/admin/staff'` (or equivalent resolve error).
- [ ] Write the implementation at `src/lib/admin/staff.ts`:

```ts
/**
 * Owner-managed staff accounts (feature wave workstream 8).
 *
 * A staff person signs in with a personal 6-digit code instead of the owner's
 * password + TOTP. The code is stored ONLY as sha256("staff-code:" + code),
 * the same hashing pattern as login_tokens.codeHash, and is shown to the owner
 * exactly once at creation or regeneration.
 *
 * Staff rows satisfy the mandatory-MFA requireAdmin gate the same way the demo
 * admin does (src/lib/auth/demo.ts): mfaEnabled=true with a throwaway
 * encrypted TOTP secret that is never verified, plus an unusable random
 * password. The password + TOTP login path therefore stays owner-only by
 * construction: staff cannot know their random password, and even the password
 * would still owe a TOTP they cannot produce.
 */
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { adminUsers } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { encryptField } from "@/lib/crypto/fields";
import { destroyAllForSubject } from "@/lib/auth/sessions";
import { Errors } from "@/lib/http/errors";

/** sha256("staff-code:" + code) — global (not per-account) because at login the
 *  code is all we have; the account is found BY the hash. */
export function hashStaffCode(code: string): string {
  return createHash("sha256").update(`staff-code:${code}`).digest("hex");
}

/** Draw codes until one collides with no existing account, so a code always
 *  identifies exactly one person. Creation is owner-only and effectively
 *  serial, so the check-then-insert race is theoretical; the retry cap keeps
 *  the loop finite even if the code space ever got crowded. */
async function generateUniqueCode(): Promise<{ code: string; codeHash: string }> {
  const db = await getDb();
  for (let i = 0; i < 10; i++) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const codeHash = hashStaffCode(code);
    const [clash] = await db.select({ id: adminUsers.id }).from(adminUsers)
      .where(eq(adminUsers.loginCodeHash, codeHash));
    if (!clash) return { code, codeHash };
  }
  throw Errors.conflict("Could not generate a unique staff code, please try again");
}

export interface StaffListRow {
  id: string;
  name: string | null;
  active: boolean;
  createdAt: Date;
}

export async function listStaff(): Promise<StaffListRow[]> {
  const db = await getDb();
  return db.select({
    id: adminUsers.id,
    name: adminUsers.name,
    active: adminUsers.active,
    createdAt: adminUsers.createdAt,
  }).from(adminUsers)
    .where(eq(adminUsers.role, "staff"))
    .orderBy(adminUsers.createdAt);
}

export interface CreatedStaff { id: string; name: string; code: string }

export async function createStaff(name: string): Promise<CreatedStaff> {
  const db = await getDb();
  const { code, codeHash } = await generateUniqueCode();
  const id = randomUUID();
  // Same well-formedness trick as the demo admin: a real (never verified)
  // encrypted TOTP secret bound to the row id via AAD.
  const totpSecretEnc = encryptField(randomBytes(20).toString("base64"), `admin_users:${id}:totp_secret`);
  // Unusable password: random, never revealed, never needed.
  const passwordHash = await hashPassword(randomBytes(24).toString("base64url"));
  await db.insert(adminUsers).values({
    id,
    email: `staff-${id}@staff.local`, // placeholder; staff have no real email
    passwordHash,
    role: "staff",
    name,
    mfaEnabled: true,
    totpSecretEnc,
    loginCodeHash: codeHash,
  });
  return { id, name, code };
}

/** Resolve a STAFF row by id; owners are invisible to this API so the staff
 *  management surface can never lock out or rekey the owner. */
async function findStaff(id: string) {
  const db = await getDb();
  const [row] = await db.select().from(adminUsers)
    .where(and(eq(adminUsers.id, id), eq(adminUsers.role, "staff")));
  if (!row) throw Errors.notFound("Staff member not found");
  return row;
}

export async function regenerateStaffCode(id: string): Promise<{ code: string }> {
  const staff = await findStaff(id);
  const db = await getDb();
  const { code, codeHash } = await generateUniqueCode();
  await db.update(adminUsers).set({
    loginCodeHash: codeHash,
    codeFailedAttempts: 0,
    codeLockedUntil: null,
    updatedAt: new Date(),
  }).where(eq(adminUsers.id, staff.id));
  // A lost or shared code is the usual reason to regenerate, so treat the old
  // code as compromised: revoke every live session for this person.
  await destroyAllForSubject("admin", staff.id);
  return { code };
}

export async function setStaffActive(id: string, active: boolean): Promise<{ id: string; active: boolean }> {
  const staff = await findStaff(id);
  const db = await getDb();
  await db.update(adminUsers).set({ active, updatedAt: new Date() }).where(eq(adminUsers.id, staff.id));
  if (!active) await destroyAllForSubject("admin", staff.id); // instant revocation
  return { id: staff.id, active };
}
```

- [ ] Run the test to verify it passes: `npm test -- --no-file-parallelism src/test/admin-staff.test.ts` — expect `5 passed`.
- [ ] Typecheck: `npx tsc --noEmit` — expect no errors.
- [ ] Commit:

```bash
git add src/lib/admin/staff.ts src/test/admin-staff.test.ts
git commit -m "feat(staff): owner-managed staff accounts lib (create, regenerate, deactivate)"
```

---

### Task 3: Staff code login lib with shared 5-fail 15-minute lockout

**Files:**
- Create: `src/lib/auth/staff-login.ts`
- Test: `src/test/staff-login.test.ts` (new)

**Interfaces:**
- Consumes: `hashStaffCode`, `createStaff` (tests) from `@/lib/admin/staff` (Task 2); `adminUsers` schema; `audit` from `@/lib/audit`; drizzle `and, eq, isNotNull, sql`.
- Produces (consumed by Task 4):
  - `STAFF_LOCK_THRESHOLD = 5`, `STAFF_LOCK_SECONDS = 900`.
  - `loginStaff(code: string, ctx?: { req?: Request }, now?: Date): Promise<{ ok: true; adminId: string; name: string | null } | { ok: false }>`.
- Design note (the seams give the columns, this is the semantics): a wrong code matches NO row, so per-account attribution is impossible. Failures therefore increment `codeFailedAttempts` on EVERY active staff row atomically (the `recordMfaFailure` CASE-WHEN pattern from `src/app/api/admin/auth/mfa/verify/route.ts` lines 29-46); when a counter reaches 5 that row locks for 15 minutes, and because all rows move in lockstep the whole staff-code path locks together. Correct-code attempts against a locked or deactivated row are rejected with the same generic failure. The owner's password + TOTP path is never affected.

**Steps:**

- [ ] Write the failing test at `src/test/staff-login.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { adminUsers, auditLog } from "@/lib/db/schema";
import { createStaff, setStaffActive, hashStaffCode } from "@/lib/admin/staff";
import { loginStaff, STAFF_LOCK_THRESHOLD, STAFF_LOCK_SECONDS } from "@/lib/auth/staff-login";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
});

/** A code guaranteed to match no account right now. */
async function wrongCode(): Promise<string> {
  for (let i = 0; i < 1_000_000; i++) {
    const c = String(i).padStart(6, "0");
    const [hit] = await db.select({ id: adminUsers.id }).from(adminUsers)
      .where(eq(adminUsers.loginCodeHash, hashStaffCode(c)));
    if (!hit) return c;
  }
  throw new Error("no unused code found");
}

describe("staff code login", () => {
  it("signs in with a correct code and resets the failure counters", async () => {
    const created = await createStaff("Maya");
    await loginStaff(await wrongCode()); // one collective failure first
    const result = await loginStaff(created.code);
    expect(result).toEqual({ ok: true, adminId: created.id, name: "Maya" });
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, created.id));
    expect(row!.codeFailedAttempts).toBe(0);
    expect(row!.codeLockedUntil).toBeNull();
  });

  it("rejects a wrong code with the same generic result as any other failure", async () => {
    expect(await loginStaff(await wrongCode())).toEqual({ ok: false });
  });

  it("rejects a deactivated staff member's correct code", async () => {
    const created = await createStaff("Rey");
    await setStaffActive(created.id, false);
    expect(await loginStaff(created.code)).toEqual({ ok: false });
  });

  it("locks the staff code path after 5 straight failures and releases after 15 minutes", async () => {
    // Normalize counters so earlier tests cannot skew the threshold.
    await db.update(adminUsers).set({ codeFailedAttempts: 0, codeLockedUntil: null });
    const created = await createStaff("Lock");
    const bad = await wrongCode();
    const t0 = new Date();
    for (let i = 0; i < STAFF_LOCK_THRESHOLD; i++) {
      expect((await loginStaff(bad, {}, t0)).ok).toBe(false);
    }
    // Locked: even the CORRECT code is rejected inside the window.
    expect((await loginStaff(created.code, {}, t0)).ok).toBe(false);
    // After the window the correct code works again (counters were reset when
    // the lock engaged).
    const later = new Date(t0.getTime() + (STAFF_LOCK_SECONDS + 1) * 1000);
    const result = await loginStaff(created.code, {}, later);
    expect(result.ok).toBe(true);
  });

  it("audit-logs failures, lockout engagement, and rejections", async () => {
    const rows = await db.select().from(auditLog);
    const actions = new Set(rows.map((r) => r.action));
    expect(actions).toContain("admin.staff_login_failed");
    expect(actions).toContain("admin.staff_lockout_engaged");
    expect(actions).toContain("admin.staff_login_rejected_locked");
    expect(actions).toContain("admin.staff_login_rejected_inactive");
  });
});
```

- [ ] Run the test to verify it fails: `npm test -- --no-file-parallelism src/test/staff-login.test.ts` — expected failure: `Cannot find module '@/lib/auth/staff-login'`.
- [ ] Write the implementation at `src/lib/auth/staff-login.ts`:

```ts
/**
 * Staff code login (feature wave workstream 8): a staff person signs in with a
 * personal 6-digit code. Deliberately weaker than the owner's password + TOTP;
 * accepted (spec-recorded trade-off) because staff scope excludes money
 * movement and settings, and four controls defend the code path: the auth-tier
 * rate limit at the route, the shared lockout below, hashed-only storage, and
 * instant owner revocation (deactivate / regenerate).
 *
 * Lockout model: a wrong code matches no account, so failures cannot be pinned
 * on one row. Every no-match failure therefore atomically increments
 * code_failed_attempts on EVERY active staff row (the recordMfaFailure
 * CASE-WHEN pattern from the MFA verify route); reaching
 * STAFF_LOCK_THRESHOLD sets code_locked_until = now + STAFF_LOCK_SECONDS and
 * resets the counter in the same UPDATE. All rows move in lockstep, so the
 * whole staff-code path locks together for 15 minutes. The owner's
 * password + TOTP login is never affected, so the desk always has a way in.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { adminUsers } from "@/lib/db/schema";
import { hashStaffCode } from "@/lib/admin/staff";
import { audit } from "@/lib/audit";

export const STAFF_LOCK_THRESHOLD = 5;
export const STAFF_LOCK_SECONDS = 900; // 15 minutes

export type StaffLoginResult =
  | { ok: true; adminId: string; name: string | null }
  | { ok: false };

/** Atomic collective failure counter. Returns true when this failure engaged
 *  (or found already engaged) a fresh lock on at least one row. */
async function recordStaffFailure(now: Date): Promise<boolean> {
  const db = await getDb();
  const lockUntil = new Date(now.getTime() + STAFF_LOCK_SECONDS * 1000);
  const tripped = sql`${adminUsers.codeFailedAttempts} + 1 >= ${STAFF_LOCK_THRESHOLD}`;
  const rows = await db.update(adminUsers)
    .set({
      codeFailedAttempts: sql`CASE WHEN ${tripped} THEN 0 ELSE ${adminUsers.codeFailedAttempts} + 1 END`,
      codeLockedUntil: sql`CASE WHEN ${tripped} THEN ${lockUntil} ELSE ${adminUsers.codeLockedUntil} END`,
      updatedAt: now,
    })
    .where(and(
      eq(adminUsers.role, "staff"),
      eq(adminUsers.active, true),
      isNotNull(adminUsers.loginCodeHash),
    ))
    .returning({ lockedUntil: adminUsers.codeLockedUntil });
  return rows.some((r) => r.lockedUntil !== null && r.lockedUntil.getTime() > now.getTime());
}

/** Verify a staff code. Generic { ok: false } on EVERY failure mode (no match,
 *  deactivated, locked) so the response never reveals which one it was; the
 *  audit log records the specific reason. `now` is injectable for tests. */
export async function loginStaff(
  code: string,
  ctx: { req?: Request } = {},
  now = new Date(),
): Promise<StaffLoginResult> {
  const db = await getDb();
  const codeHash = hashStaffCode(code);
  const [match] = await db.select().from(adminUsers)
    .where(and(eq(adminUsers.loginCodeHash, codeHash), eq(adminUsers.role, "staff")));

  if (!match) {
    const locked = await recordStaffFailure(now);
    await audit({
      actor: "anonymous",
      action: locked ? "admin.staff_lockout_engaged" : "admin.staff_login_failed",
      entity: "admin_user",
      req: ctx.req,
    });
    return { ok: false };
  }

  if (!match.active) {
    await audit({
      actor: match.id, action: "admin.staff_login_rejected_inactive",
      entity: "admin_user", entityId: match.id, req: ctx.req,
    });
    return { ok: false };
  }

  if (match.codeLockedUntil && match.codeLockedUntil.getTime() > now.getTime()) {
    await audit({
      actor: match.id, action: "admin.staff_login_rejected_locked",
      entity: "admin_user", entityId: match.id, req: ctx.req,
    });
    return { ok: false };
  }

  await db.update(adminUsers)
    .set({ codeFailedAttempts: 0, codeLockedUntil: null, updatedAt: now })
    .where(eq(adminUsers.id, match.id));
  return { ok: true, adminId: match.id, name: match.name };
}
```

- [ ] Run the test to verify it passes: `npm test -- --no-file-parallelism src/test/staff-login.test.ts` — expect `5 passed`.
- [ ] Typecheck: `npx tsc --noEmit` — expect no errors.
- [ ] Commit:

```bash
git add src/lib/auth/staff-login.ts src/test/staff-login.test.ts
git commit -m "feat(staff): staff code login with shared 5-fail 15-minute lockout"
```

---

### Task 4: Staff login route, admin.login audit marker, session plumbing

**Files:**
- Create: `src/app/api/admin/auth/staff-login/route.ts`
- Modify: `src/app/api/admin/auth/mfa/verify/route.ts` (lines 112-113: after `rotateSession`)
- Modify: `src/app/api/admin/auth/me/route.ts` (line 10: roles + name in response)
- Modify: `src/app/api/admin/auth/logout/route.ts` (line 14: roles)
- Modify: `src/lib/auth/admin-auth.ts` (line 52: active check)
- Test: covered by Task 3 lib tests + `npx tsc --noEmit`; route wiring is thin by repo convention (logic lives in libs, routes are wrappers — same as `admin-login`).

**Interfaces:**
- Consumes: `loginStaff` (Task 3); `createSession`, `applySessionCookies`, `trustedClientIp`, `enforceRateLimit`, `parseJsonBody`, `withRoute`, `json`, `Errors`, `audit` — all existing, exact usage mirrors `src/app/api/admin/auth/login/route.ts` and `demo/route.ts`.
- Produces (seam, verbatim): `POST /api/admin/auth/staff-login` body `{ code: string }` (rate-limited `auth` tier; 5 fails → 15 min lock). Success sets the normal session + CSRF cookies and returns `{ ok: true }`; every failure is a generic 401. Audit action `admin.login` written on every successful login (both paths).

**Steps:**

- [ ] Create `src/app/api/admin/auth/staff-login/route.ts`:

```ts
import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { Errors } from "@/lib/http/errors";
import { loginStaff } from "@/lib/auth/staff-login";
import { createSession } from "@/lib/auth/sessions";
import { applySessionCookies } from "@/lib/auth/session-cookies";
import { trustedClientIp } from "@/lib/http/client-ip";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const BodySchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits"),
}).strict();

/**
 * POST /api/admin/auth/staff-login — staff second login path (workstream 8).
 * A personal 6-digit code maps to exactly one staff admin_user; success mints
 * a FULL session bound to that person, so every mutate() audit entry carries
 * their id. Defenses: auth-tier per-client rate limit here, the shared 5-fail
 * 15-minute lockout inside loginStaff, hashed-only code storage, and instant
 * owner revocation. Every failure mode returns the SAME generic 401 (no
 * lock/deactivation oracle). Staff rows are provisioned mfaEnabled=true with a
 * throwaway secret (demo-admin pattern), so requireAdmin's mandatory-MFA gate
 * admits the session without weakening the owner path.
 */
export const POST = withRoute(async (req) => {
  await enforceRateLimit(req, "auth", "admin-staff-login");
  const body = await parseJsonBody(req, BodySchema);

  const result = await loginStaff(body.code, { req });
  if (!result.ok) throw Errors.unauthorized("Invalid code");

  const created = await createSession({
    subjectType: "admin",
    subjectId: result.adminId,
    mfaPending: false,
    ip: trustedClientIp(req),
    ua: req.headers.get("user-agent"),
  });

  // Canonical who-logged-in marker (seams: `admin.login` on BOTH login paths).
  await audit({ actor: result.adminId, action: "admin.login", entity: "admin_user", entityId: result.adminId, req });
  return applySessionCookies(json({ ok: true }, req), created);
});
```

- [ ] Modify `src/app/api/admin/auth/mfa/verify/route.ts` — the owner path's successful login completes here (session rotates to full), so write the same marker. Replace:

```ts
  const rotated = await rotateSession(session, { mfaPending: false });
  return applySessionCookies(json({ ok: true }, req), rotated);
```

with:

```ts
  const rotated = await rotateSession(session, { mfaPending: false });
  // Canonical who-logged-in marker (seams: `admin.login` on BOTH login paths;
  // the staff-login route writes the same action), so "who logged in when" is
  // a single audit filter.
  await audit({ actor: admin.id, action: "admin.login", entity: "admin_user", entityId: admin.id, req });
  return applySessionCookies(json({ ok: true }, req), rotated);
```

(`audit` is already imported in that file, line 16.)
- [ ] Modify `src/lib/auth/admin-auth.ts` — deactivated accounts must die at the guard, not only at login. After line 52 (`if (!admin) throw Errors.unauthorized("Account no longer exists");`) insert:

```ts
  // Instant revocation (workstream 8): a deactivated account is dead even if a
  // session somehow survived the destroy-all at deactivation time.
  if (!admin.active) throw Errors.unauthorized("Account is deactivated");
```

- [ ] Modify `src/app/api/admin/auth/me/route.ts` — staff sessions must be able to identify themselves (the shell and pages call this). Replace the handler body:

```ts
export const GET = withRoute(async (req) => {
  const { admin, session } = await requireAdmin(req, { allowMfaPending: true });
  return json({
    email: admin.email,
    role: admin.role,
    mfaEnabled: admin.mfaEnabled,
    mfaPending: session.mfaPending,
  }, req);
});
```

with:

```ts
export const GET = withRoute(async (req) => {
  const { admin, session } = await requireAdmin(req, {
    allowMfaPending: true,
    roles: ["owner", "staff"],
  });
  return json({
    email: admin.email,
    name: admin.name,
    role: admin.role,
    mfaEnabled: admin.mfaEnabled,
    mfaPending: session.mfaPending,
  }, req);
});
```

- [ ] Modify `src/app/api/admin/auth/logout/route.ts` — staff must be able to sign out. Replace line 14:

```ts
  const { admin } = await requireAdmin(req, { allowMfaPending: true });
```

with:

```ts
  const { admin } = await requireAdmin(req, { allowMfaPending: true, roles: ["owner", "staff"] });
```

- [ ] Typecheck: `npx tsc --noEmit` — expect no errors. Lint: `npm run lint` — expect no new warnings.
- [ ] Run the full auth-related tests to catch regressions: `npm test -- --no-file-parallelism src/test/admin-login.test.ts src/test/staff-login.test.ts src/test/sessions.test.ts` — expect all passing.
- [ ] Commit:

```bash
git add src/app/api/admin/auth/staff-login/route.ts src/app/api/admin/auth/mfa/verify/route.ts src/app/api/admin/auth/me/route.ts src/app/api/admin/auth/logout/route.ts src/lib/auth/admin-auth.ts
git commit -m "feat(staff): staff-login route, admin.login audit marker, session plumbing"
```

---

### Task 5: Owner-only staff CRUD routes

**Files:**
- Create: `src/app/api/admin/staff/route.ts`
- Create: `src/app/api/admin/staff/[id]/route.ts`
- Create: `src/app/api/admin/staff/[id]/regenerate/route.ts`
- Test: lib behavior already covered in Task 2; verify wiring via `npx tsc --noEmit` (routes are thin wrappers, repo convention).

**Interfaces:**
- Consumes: `listStaff`, `createStaff`, `regenerateStaffCode`, `setStaffActive` from `@/lib/admin/staff` (Task 2); `read`/`mutate` from `@/lib/admin/guard` (owner-only DEFAULT roles — pass no roles option); `withRoute`, `json`, `parseJsonBody`, `parseParams`.
- Produces (seam, verbatim): `GET/POST /api/admin/staff`, `POST /api/admin/staff/[id]/regenerate`, `PATCH /api/admin/staff/[id]` (`{active}`); owner-only.
  - `GET /api/admin/staff` → `{ staff: [{ id, name, active, createdAt }] }`
  - `POST /api/admin/staff` body `{ name: string }` → 201 `{ id, name, code }` (code appears here ONCE and nowhere else)
  - `POST /api/admin/staff/[id]/regenerate` → `{ code }`
  - `PATCH /api/admin/staff/[id]` body `{ active: boolean }` → `{ id, active }`
- CRITICAL: the plaintext code must NEVER be placed in the audit `after` payload (audit rows are readable on the audit page); mutate's `after` carries only name/active.

**Steps:**

- [ ] Create `src/app/api/admin/staff/route.ts`:

```ts
import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { read, mutate } from "@/lib/admin/guard";
import { listStaff, createStaff } from "@/lib/admin/staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/staff — owner-only staff roster (default deny keeps staff out). */
export const GET = withRoute(async (req) =>
  json({ staff: await read(req, () => listStaff()) }, req),
);

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
}).strict();

/** POST /api/admin/staff — create a staff member. The 6-digit code is returned
 *  ONCE in this response and never stored in plaintext or audit-logged. */
export const POST = withRoute(async (req) => {
  const body = await parseJsonBody(req, CreateSchema);
  const created = await mutate(req, "admin.staff_created", async () => {
    const staff = await createStaff(body.name);
    return {
      result: staff, entity: "admin_user", entityId: staff.id,
      after: { name: staff.name, role: "staff" }, // NEVER the code
    };
  });
  return json(created, req, { status: 201 });
});
```

- [ ] Create `src/app/api/admin/staff/[id]/route.ts`:

```ts
import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody, parseParams } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { setStaffActive } from "@/lib/admin/staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
const BodySchema = z.object({ active: z.boolean() }).strict();

/** PATCH /api/admin/staff/[id] — activate / deactivate (owner-only). Deactivation
 *  destroys the person's sessions inside setStaffActive: instant revocation. */
export const PATCH = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const body = await parseJsonBody(req, BodySchema);
  const result = await mutate(req, "admin.staff_updated", async () => {
    const r = await setStaffActive(id, body.active);
    return { result: r, entity: "admin_user", entityId: id, after: { active: r.active } };
  });
  return json(result, req);
});
```

- [ ] Create `src/app/api/admin/staff/[id]/regenerate/route.ts`:

```ts
import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { regenerateStaffCode } from "@/lib/admin/staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

/** POST /api/admin/staff/[id]/regenerate — issue a fresh code (owner-only). The
 *  old code stops working and live sessions are revoked inside the lib. The new
 *  code appears ONCE in this response; the audit entry never contains it. */
export const POST = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const result = await mutate(req, "admin.staff_code_regenerated", async () => {
    const r = await regenerateStaffCode(id);
    return { result: r, entity: "admin_user", entityId: id };
  });
  return json(result, req);
});
```

- [ ] Typecheck: `npx tsc --noEmit` — expect no errors. Lint: `npm run lint` — expect no new warnings.
- [ ] Commit:

```bash
git add src/app/api/admin/staff
git commit -m "feat(staff): owner staff CRUD routes (create, regenerate, activate toggle)"
```

---

### Task 6: Role opt-ins on the staff capability routes

**Files (exist in the pre-wave tree, exact current anchors given):**
- Modify: `src/app/api/admin/planning/route.ts` (line 26)
- Modify: `src/app/api/admin/bookings/route.ts` (the `mutate(` call, currently line 12)
- Modify: `src/app/api/admin/bookings/[id]/move/route.ts` (the `mutate(` call, currently line 16)
- Modify: `src/app/api/admin/vehicles/route.ts` (line 10, GET only — POST stays owner-only)

**Files (created by earlier wave plans, merged before this plan runs — locate, then apply the same one-argument change):**
- Modify: `src/app/api/admin/bookings/[id]/extend/route.ts` (plan 02)
- Modify: `src/app/api/admin/bookings/[id]/inspection/[kind]/route.ts` (plan 06)
- Modify: `src/app/api/admin/bookings/[id]/inspection/[kind]/complete/route.ts` (plan 06)
- Modify: `src/app/api/admin/uploads/route.ts` (plan 06)
- Modify: `src/app/api/admin/compliance/route.ts` (plan 03)
- Modify: every vehicle-notes route file created by plan 04 (find them with `grep -rl "vehicle" src/app/api/admin/vehicles --include=route.ts | xargs grep -l "notes"` or `ls src/app/api/admin/vehicles/[id]/notes` — all handlers in those files)

**Interfaces:**
- Consumes: `read(req, fn, opts?)` and `mutate(req, action, fn, opts?)` from `@/lib/admin/guard` — both already accept `opts: RequireAdminOptions` with `roles?: ("owner" | "staff")[]` as the FINAL argument (see `src/lib/admin/guard.ts` lines 14-21 and 31-37). `requireAdmin` defaults to `["owner"]` (deny-by-default, `src/lib/auth/admin-auth.ts` line 69), so untouched routes stay owner-only.
- Produces: the exact staff opt-in list from the seams doc — "planning, bookings create/move/extend(desk+link), inspection routes, uploads, vehicle notes, fleet read, compliance read". Nothing else changes.

**Explicitly NOT opted in (leave untouched, owner-only):** `settings`, `vehicles` POST/PATCH/DELETE, `vehicles/[id]/blocks`, `blackouts`, `addons`, `insurance`, `policies`, `reports` (all), `audit`, `staff` (Task 5), `bookings/[id]/cancel` (admin cancel offers a refund choice → owner), `payments/[id]/refund`, `notifications` + `notifications/read` (the bell is hidden for staff in Task 9; its fetch failures are already swallowed in `notification-bell.tsx` lines 18 and 28).

**Steps:**

- [ ] `src/app/api/admin/planning/route.ts` line 26 — replace:

```ts
  return json(await read(req, () => getPlanning(from, to)), req);
```

with:

```ts
  // Staff opt-in (workstream 8): the planning board is the staff home surface.
  return json(await read(req, () => getPlanning(from, to), { roles: ["owner", "staff"] }), req);
```

- [ ] `src/app/api/admin/bookings/route.ts` — the POST handler's `mutate(req, "admin.manual_booking_created", async () => { ... })` call gets the roles option as its 4th argument: replace the call's closing line (currently `  });`, the one directly before `return json({ id: booking.id }, req, { status: 201 });`) with:

```ts
  }, { roles: ["owner", "staff"] });
```

- [ ] `src/app/api/admin/bookings/[id]/move/route.ts` — same shape: the `mutate(req, "admin.booking_moved", async () => { ... })` call's closing `  });` becomes:

```ts
  }, { roles: ["owner", "staff"] });
```

- [ ] `src/app/api/admin/vehicles/route.ts` line 10 (GET only) — replace:

```ts
export const GET = withRoute(async (req) => json(await read(req, listVehicles), req));
```

with:

```ts
// Fleet READ is staff-visible (workstream 8); create/edit below stay owner-only.
export const GET = withRoute(async (req) => json(await read(req, listVehicles, { roles: ["owner", "staff"] }), req));
```

- [ ] For each wave-created file listed above (`extend`, both `inspection` routes, `uploads`, `compliance`, and every vehicle-notes route): open the file, find every `read(req, ...)` / `mutate(req, "...", ...)` call, and add `{ roles: ["owner", "staff"] }` as the final argument, exactly as done above (if a call already passes an opts object for another reason, add the `roles` key to it instead of a new argument). Note the file may contain multiple handlers (GET + POST etc.); opt in every handler in these files — they are all inside the staff capability list. If any of these files does not exist, STOP and report it (an earlier plan did not merge as expected) instead of guessing.
- [ ] Verify coverage:

```bash
grep -rn 'roles: \["owner", "staff"\]' src/app/api/admin | sort
```

Expected: hits in planning, bookings (create), bookings move, bookings extend, both inspection routes, uploads, compliance, vehicles GET, every vehicle-notes route, plus the me/logout routes from Task 4. Also verify no accidental opt-in:

```bash
grep -rln 'roles: \["owner", "staff"\]' src/app/api/admin/settings src/app/api/admin/reports src/app/api/admin/audit src/app/api/admin/policies src/app/api/admin/staff 2>/dev/null
```

Expected: no output.
- [ ] Typecheck: `npx tsc --noEmit` — expect no errors.
- [ ] Run the full suite to catch signature drift: `npm test -- --no-file-parallelism` — expect all green (this task changes no logic, only guard options).
- [ ] Commit:

```bash
git add src/app/api/admin
git commit -m "feat(staff): role opt-ins for the staff capability routes"
```

---

### Task 7: Audit lib upgrade — action filter + human actor labels

**Files:**
- Modify: `src/lib/admin/audit.ts` (whole file, 21 lines — full replacement below)
- Modify: `src/app/admin/(shell)/audit/page.tsx` (interface line 9-12, `actor` helper line 24-25, search predicate line 42, actor cell line 134)
- Test: extend `src/test/admin-audit.test.ts` (currently 29 lines)

**Interfaces:**
- Consumes: `auditLog`, `adminUsers` from `@/lib/db/schema`; drizzle `and, lt, desc, eq, inArray`.
- Produces (consumed by Task 10's Recent logins card and by the audit page):
  - `AuditQuerySchema` gains optional `action: string` (so `GET /api/admin/audit?limit=15&action=admin.login` works through the EXISTING route `src/app/api/admin/audit/route.ts` with zero route changes — it already parses all search params through this schema).
  - `listAudit(q)` returns `AuditRowWithActor[]` where `AuditRowWithActor = AuditRow & { actorLabel: string }` — `actorLabel` is the admin's `name` (staff) or `email` (owner) when the actor is an admin id, otherwise the raw actor string ("anonymous", "system", customer ids).

**Steps:**

- [ ] Add the failing tests: append these two `it` blocks inside the `describe("audit viewer", ...)` in `src/test/admin-audit.test.ts`, and extend its imports. New full import section at the top of the file:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { auditLog, adminUsers } from "@/lib/db/schema";
import { listAudit } from "@/lib/admin/audit";
```

New `it` blocks (append before the closing `});` of the describe):

```ts
  it("filters by action", async () => {
    const rows = await listAudit({ limit: 50, action: "test.event_1" });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.action).toBe("test.event_1");
  });

  it("resolves admin actors to a person label, name first then email", async () => {
    const db = await getDb();
    const [named] = await db.insert(adminUsers).values({
      email: "staff-label@staff.local", passwordHash: "x", role: "staff", name: "Maya",
    }).returning();
    const [unnamed] = await db.insert(adminUsers).values({
      email: "owner-label@fleetdesk.app", passwordHash: "x",
    }).returning();
    await db.insert(auditLog).values({ actor: named!.id, action: "test.labeled", entity: "test" });
    await db.insert(auditLog).values({ actor: unnamed!.id, action: "test.labeled", entity: "test" });
    const rows = await listAudit({ limit: 10, action: "test.labeled" });
    const labels = rows.map((r) => r.actorLabel).sort();
    expect(labels).toEqual(["Maya", "owner-label@fleetdesk.app"]);
    // Non-admin actors fall back to the raw actor string.
    const system = await listAudit({ limit: 5, action: "test.event_0" });
    expect(system[0]!.actorLabel).toBe("system");
  });
```

- [ ] Run to verify failure: `npm test -- --no-file-parallelism src/test/admin-audit.test.ts` — expected failure: the `action` filter is ignored (rows of other actions come back, `expected 'test.event_0' to be 'test.event_1'` or similar) and `actorLabel` is `undefined`.
- [ ] Replace `src/lib/admin/audit.ts` entirely with:

```ts
import { z } from "zod";
import { and, lt, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { auditLog, adminUsers } from "@/lib/db/schema";

export type AuditRow = typeof auditLog.$inferSelect;
/** Audit row plus a person label: the admin's name (staff) or email (owner)
 *  when the actor is an admin id; the raw actor string otherwise
 *  ("anonymous", "system", customer ids). Answers "who did what" (workstream 8). */
export type AuditRowWithActor = AuditRow & { actorLabel: string };

export const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime().optional(), // ISO timestamp cursor
  action: z.string().trim().min(1).max(80).optional(), // exact action match, e.g. admin.login
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Newest-first audit page (read-only; the table has no mutation path). */
export async function listAudit(q: z.infer<typeof AuditQuerySchema>): Promise<AuditRowWithActor[]> {
  const db = await getDb();
  const conds = [];
  if (q.before) conds.push(lt(auditLog.createdAt, new Date(q.before)));
  if (q.action) conds.push(eq(auditLog.action, q.action));
  const base = db.select().from(auditLog);
  const rows = conds.length
    ? await base.where(and(...conds)).orderBy(desc(auditLog.createdAt)).limit(q.limit)
    : await base.orderBy(desc(auditLog.createdAt)).limit(q.limit);

  const ids = [...new Set(rows.map((r) => r.actor).filter((a) => UUID_RE.test(a)))];
  const admins = ids.length
    ? await db.select({ id: adminUsers.id, name: adminUsers.name, email: adminUsers.email })
        .from(adminUsers).where(inArray(adminUsers.id, ids))
    : [];
  const labels = new Map(admins.map((a) => [a.id, a.name ?? a.email]));
  return rows.map((r) => ({ ...r, actorLabel: labels.get(r.actor) ?? r.actor }));
}
```

- [ ] Run to verify pass: `npm test -- --no-file-parallelism src/test/admin-audit.test.ts` — expect `4 passed`.
- [ ] Update the audit page `src/app/admin/(shell)/audit/page.tsx` to show the label. Three edits:

Edit 1 — the row interface (lines 9-12) becomes:

```ts
interface AuditRow {
  id: string; actor: string; actorLabel: string; action: string; entity: string;
  entityId: string | null; ip: string | null; createdAt: string;
}
```

Edit 2 — the `actor` display helper (lines 24-25) becomes:

```ts
  const actor = (r: AuditRow) =>
    r.actorLabel !== r.actor ? r.actorLabel :
    r.actor === "anonymous" || r.actor === "system" ? r.actor : r.actor.slice(0, 8);
```

Edit 3 — the search predicate: inside the `visible` memo, replace the line `r.actor.toLowerCase().includes(q) ||` with:

```ts
        r.actor.toLowerCase().includes(q) ||
        r.actorLabel.toLowerCase().includes(q) ||
```

Edit 4 — the actor cell (line 134) `{actor(r.actor)}` becomes `{actor(r)}`.
- [ ] Typecheck: `npx tsc --noEmit`. Lint: `npm run lint`. Both clean.
- [ ] Manual verification: with the dev server running (`npm run dev`, never alongside a build), sign in as owner and open `http://localhost:3000/admin/audit` — actor column now shows emails/names instead of id prefixes for admin actions; searching for part of an email narrows the list.
- [ ] Commit:

```bash
git add src/lib/admin/audit.ts "src/app/admin/(shell)/audit/page.tsx" src/test/admin-audit.test.ts
git commit -m "feat(audit): action filter and human actor labels for who-did-what"
```

---

### Task 8: Staff code path on the admin sign-in screen

**Files:**
- Modify: `src/app/admin/(auth)/login/page.tsx` (full replacement below; current file is 80 lines)
- Test: UI task — TDD impractical; verify via typecheck, lint, and the manual steps below.

**Interfaces:**
- Consumes: `POST /api/admin/auth/staff-login` `{ code }` (Task 4); `api`, `ApiError` from `../../client` (`src/app/admin/client.ts`); existing `auth-card`, `field`, `btn`, `btn--quiet`, `msg err`, `sub`, `demo-panel` CSS classes from `src/app/admin/admin.css`.
- Produces: a two-mode sign-in card. Owner mode is byte-identical in behavior to today (email + password → `/admin/mfa`). Staff mode: one 6-digit code input → on success straight to `/admin` (staff sessions are already full; the shell admits them via the mfaEnabled provisioning trick).

**Steps:**

- [ ] Replace `src/app/admin/(auth)/login/page.tsx` entirely with:

```tsx
"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, type ApiError } from "../../client";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

export default function AdminLoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"owner" | "staff">("owner");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function enterDemo() {
    setError("");
    setBusy(true);
    try {
      await api("/api/admin/auth/demo", {});
      router.push("/admin");
    } catch {
      setError("The demo is not available right now. Please try again shortly.");
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api<{ mfaRequired?: boolean; enrollRequired?: boolean }>(
        "/api/admin/auth/login",
        { email, password },
      );
      router.push("/admin/mfa");
    } catch (err) {
      const apiErr = err as ApiError;
      setError(
        apiErr.status === 429
          ? `Too many attempts. Try again in ${apiErr.retryAfter ?? "a few"} seconds.`
          : "Invalid email or password.",
      );
      setBusy(false);
    }
  }

  async function onStaffSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("/api/admin/auth/staff-login", { code });
      router.push("/admin");
    } catch (err) {
      const apiErr = err as ApiError;
      setError(
        apiErr.status === 429
          ? `Too many attempts. Try again in ${apiErr.retryAfter ?? "a few"} seconds.`
          : "That code did not work. Check it and try again.",
      );
      setBusy(false);
    }
  }

  function switchMode(next: "owner" | "staff") {
    setMode(next);
    setError("");
    setCode("");
  }

  if (mode === "staff") {
    return (
      <form className="auth-card" onSubmit={onStaffSubmit}>
        <p className="auth-brand">FleetDesk</p>
        <h1>Staff sign in</h1>
        <p className="sub">Enter your personal 6-digit code.</p>
        <div className="field">
          <label htmlFor="staff-code">Staff code</label>
          <input
            id="staff-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
        </div>
        <button className="btn" disabled={busy || code.length !== 6}>
          {busy ? "Signing in…" : "Sign in with code"}
        </button>
        <p className="msg err" role="alert">{error}</p>
        <button type="button" className="btn btn--quiet" onClick={() => switchMode("owner")}>
          Owner sign in with email and password
        </button>
      </form>
    );
  }

  return (
    <form className="auth-card" onSubmit={onSubmit}>
      <p className="auth-brand">FleetDesk</p>
      <h1>Sign in</h1>
      <p className="sub">Welcome back to the operations dashboard.</p>

      {DEMO_MODE && (
        <div className="demo-panel">
          <button type="button" className="btn btn-demo" onClick={enterDemo} disabled={busy}>
            {busy ? "Opening…" : "Enter the live demo →"}
          </button>
          <p className="demo-hint">No sign-in needed. Explore the full operations dashboard with sample data.</p>
          <div className="demo-divider"><span>or sign in</span></div>
        </div>
      )}

      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" required
          value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" required
          value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <button className="btn" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      <p className="msg err" role="alert">{error}</p>
      <button type="button" className="btn btn--quiet" onClick={() => switchMode("staff")}>
        Staff member? Sign in with your code
      </button>
    </form>
  );
}
```

- [ ] Typecheck: `npx tsc --noEmit`. Lint: `npm run lint`. Both clean.
- [ ] Manual verification: `npm run dev`, open `http://localhost:3000/admin/login`. Confirm: (1) the owner form looks and behaves as before; (2) "Staff member? Sign in with your code" flips to the code card; (3) a garbage code shows "That code did not work. Check it and try again."; (4) the back link returns to the owner form. Full staff happy-path is verified end-to-end in Task 10 (needs a created staff member).
- [ ] Commit:

```bash
git add "src/app/admin/(auth)/login/page.tsx"
git commit -m "feat(staff): staff code path on the admin sign-in screen"
```

---

### Task 9: Role-aware admin shell (nav, bell, footer, deactivation gate)

**Files:**
- Modify: `src/app/admin/(shell)/layout.tsx` (guard block currently lines 51-60, aside footer line 79, topbar line 85, `<SideNav />` line 77)
- Modify: `src/app/admin/(shell)/side-nav.tsx` (full replacement below; current file is 31 lines)
- Test: UI task — typecheck, lint, manual verification.

**Interfaces:**
- Consumes: `admin.role`, `admin.name`, `admin.active` from the `adminUsers` row the layout already loads server-side (Task 1 columns).
- Produces: `SideNav` signature changes to `function SideNav({ role }: { role: "owner" | "staff" })`. Staff see ONLY Dashboard and Fleet & pricing (the two staff-readable pages; everything else 403s at the API anyway — hiding is presentation, the guard is the boundary). Owners additionally get the new `/admin/staff` link. The notification bell renders for owners only (its APIs stay owner-only per Task 6; `notification-bell.tsx` swallows fetch errors, but not polling at all is cleaner). Footer shows the person's name when set.

**Steps:**

- [ ] Edit `src/app/admin/(shell)/layout.tsx`. Four small edits (if plans 01-07 shifted line numbers, anchor on the quoted text — the semantics are unchanged):

Edit 1 — deactivation gate. After the line `if (!admin) redirect("/admin/login");` insert:

```ts
  if (!admin.active) redirect("/admin/login"); // deactivated staff: instant revocation
```

Edit 2 — MFA redirect must not trap staff (their MFA flag is the provisioning trick, so this line is fine as-is — verify it reads exactly `if (!admin.mfaEnabled) redirect("/admin/mfa");` and leave it unchanged; staff rows always have `mfaEnabled=true`).

Edit 3 — pass the role into the nav. Replace:

```tsx
          <SideNav />
```

with:

```tsx
          <SideNav role={admin.role} />
```

Edit 4 — footer label + owner-only bell. Replace:

```tsx
            <span className="foot-acct">{admin.email} · {admin.role}</span>
```

with:

```tsx
            <span className="foot-acct">{admin.name ?? admin.email} · {admin.role}</span>
```

and replace:

```tsx
            <NotificationBell />
```

with:

```tsx
            {admin.role === "owner" && <NotificationBell />}
```

- [ ] Replace `src/app/admin/(shell)/side-nav.tsx` entirely with (note: if an earlier wave plan added or removed entries in `LINKS`, carry those entries over into this list, marking them `staff: true` ONLY if they belong to the staff capability list in this plan's Global Constraints):

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavLink { href: string; label: string; staff?: boolean }

// staff: true marks the pages a staff code login may use (workstream 8).
// Everything else is owner-only and hidden from staff. Hiding is presentation
// only; the API role guards enforce the same list server-side.
const LINKS: NavLink[] = [
  { href: "/admin", label: "Dashboard", staff: true },
  { href: "/admin/reports", label: "Reports" },
  { href: "/admin/fleet", label: "Fleet & pricing", staff: true },
  { href: "/admin/catalog", label: "Add-ons & insurance" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/policies", label: "Policies" },
  { href: "/admin/staff", label: "Staff" },
  { href: "/admin/audit", label: "Audit log" },
];

export function SideNav({ role }: { role: "owner" | "staff" }) {
  const pathname = usePathname();
  const visible = role === "staff" ? LINKS.filter((l) => l.staff) : LINKS;
  return (
    <nav className="side-nav">
      {visible.map((l) => {
        const active = l.href === "/admin" ? pathname === "/admin" : pathname.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

(The old dead `Bookings (Plan 04)` placeholder anchor is dropped here if it still exists; if an earlier wave plan already replaced it with a real link, keep that link instead and role-tag it per the capability list.)
- [ ] Typecheck: `npx tsc --noEmit`. Lint: `npm run lint`. Both clean.
- [ ] Manual verification: `npm run dev`; sign in as owner; confirm the nav now shows a "Staff" entry between Policies and Audit log, the bell still renders, and the footer still shows your email. (Staff-side verification happens in Task 10 once a staff member exists.)
- [ ] Commit:

```bash
git add "src/app/admin/(shell)/layout.tsx" "src/app/admin/(shell)/side-nav.tsx"
git commit -m "feat(staff): role-aware admin shell nav, owner-only bell, deactivation gate"
```

---

### Task 10: /admin/staff management page (create, one-time code reveal, regenerate, deactivate, recent logins)

**Files:**
- Create: `src/app/admin/(shell)/staff/page.tsx`
- Create: `src/app/admin/(shell)/staff/staff.css`
- Test: UI task — typecheck, lint, manual verification (full end-to-end staff flow).

**Interfaces:**
- Consumes:
  - `GET /api/admin/staff` → `{ staff: [{ id, name, active, createdAt }] }` (Task 5)
  - `POST /api/admin/staff` `{ name }` → `{ id, name, code }` (Task 5)
  - `POST /api/admin/staff/[id]/regenerate` → `{ code }` (Task 5)
  - `PATCH /api/admin/staff/[id]` `{ active }` (Task 5)
  - `GET /api/admin/audit?limit=15&action=admin.login` → rows with `actorLabel`, `createdAt` (Task 7)
  - `Modal, Skeleton, EmptyState, useConfirm, useToast` from `@/app/admin/_ui`; `api, apiGet, apiPatch, ApiError` from `../../client`; global admin.css classes `panel`, `grid`, `tag`, `field`, `btn`, `btn--quiet`, `sub`.
- Produces: the owner staff console. Codes render exactly once in a Modal; nothing on this page ever re-displays a code.

**Steps:**

- [ ] Create `src/app/admin/(shell)/staff/staff.css`:

```css
/* Staff logins page (workstream 8). Scoped by .staff-* prefixes; base panel,
   grid, field, and button styles come from admin.css. */
.staff-head { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 1.1rem; }
.staff-head .sub { color: var(--ink-soft); font-size: .92rem; margin: .25rem 0 0; }
.staff-stack { display: grid; gap: 1.1rem; }
.staff-panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: .9rem; }
.staff-panel-head h2 { font-size: 1.02rem; margin: 0; }
.staff-create { display: flex; gap: .8rem; align-items: flex-end; max-width: 480px; }
.staff-create .field { flex: 1; margin-bottom: 0; }
.staff-create .btn { width: auto; padding: .65rem 1.1rem; white-space: nowrap; }
.staff-actions { display: flex; gap: .4rem; justify-content: flex-end; }
.staff-actions .btn { width: auto; }
.staff-code {
  font-family: var(--font-mono);
  font-size: 2.2rem;
  font-weight: 600;
  letter-spacing: .35em;
  text-align: center;
  margin: .4rem 0 .8rem;
  padding-left: .35em; /* optically recenters the letter-spaced digits */
}
```

- [ ] Create `src/app/admin/(shell)/staff/page.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, apiGet, apiPatch, type ApiError } from "../../client";
import { Modal, Skeleton, EmptyState, useConfirm, useToast } from "@/app/admin/_ui";
import "./staff.css";

interface StaffRow { id: string; name: string | null; active: boolean; createdAt: string }
interface LoginRow { id: string; actorLabel: string; createdAt: string }
interface CodeReveal { name: string; code: string }

export default function StaffPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [logins, setLogins] = useState<LoginRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<CodeReveal | null>(null);

  const load = useCallback(async () => {
    try {
      const [roster, loginRows] = await Promise.all([
        apiGet<{ staff: StaffRow[] }>("/api/admin/staff"),
        apiGet<LoginRow[]>("/api/admin/audit?limit=15&action=admin.login"),
      ]);
      setStaff(roster.staff);
      setLogins(loginRows);
    } catch (err) {
      if ((err as ApiError).status === 403) setForbidden(true);
      else toast.show({ type: "error", message: (err as ApiError).message });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const created = await api<{ id: string; name: string; code: string }>(
        "/api/admin/staff", { name: trimmed },
      );
      setName("");
      setReveal({ name: created.name, code: created.code });
      await load();
    } catch (err) {
      toast.show({ type: "error", message: (err as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  async function onRegenerate(row: StaffRow) {
    const ok = await confirm({
      title: "Regenerate login code?",
      message: `${row.name ?? "This staff member"} gets a new 6-digit code. The old code stops working right away and any open session is signed out.`,
      confirmLabel: "Regenerate",
    });
    if (!ok) return;
    try {
      const r = await api<{ code: string }>(`/api/admin/staff/${row.id}/regenerate`, {});
      setReveal({ name: row.name ?? "Staff member", code: r.code });
    } catch (err) {
      toast.show({ type: "error", message: (err as ApiError).message });
    }
  }

  async function onToggleActive(row: StaffRow) {
    if (row.active) {
      const ok = await confirm({
        title: "Deactivate this staff member?",
        message: `${row.name ?? "This staff member"} can no longer sign in and any open session is signed out. You can reactivate later.`,
        confirmLabel: "Deactivate",
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await apiPatch(`/api/admin/staff/${row.id}`, { active: !row.active });
      toast.show({
        type: "success",
        message: row.active ? "Staff member deactivated." : "Staff member reactivated.",
      });
      await load();
    } catch (err) {
      toast.show({ type: "error", message: (err as ApiError).message });
    }
  }

  if (forbidden) {
    return (
      <EmptyState
        title="Owner access only"
        hint="Staff management is available to the owner account. Sign in as the owner to manage staff logins."
      />
    );
  }

  return (
    <>
      <header className="staff-head">
        <div>
          <h1>Staff logins</h1>
          <p className="sub">Give each person their own 6-digit code, so every action shows who did it.</p>
        </div>
      </header>

      <div className="staff-stack">
        <div className="panel">
          <div className="staff-panel-head"><h2>Add a staff member</h2></div>
          <form onSubmit={onCreate} className="staff-create">
            <div className="field">
              <label htmlFor="staff-name">Name</label>
              <input id="staff-name" value={name} maxLength={80} required
                placeholder="For example: Maya"
                onChange={(e) => setName(e.target.value)} />
            </div>
            <button className="btn" disabled={busy || name.trim() === ""}>
              {busy ? "Creating…" : "Create staff login"}
            </button>
          </form>
        </div>

        <div className="panel">
          <div className="staff-panel-head"><h2>Team</h2></div>
          {loading ? (
            <table className="grid" aria-busy="true">
              <thead><tr><th>Name</th><th>Status</th><th>Since</th><th /></tr></thead>
              <tbody>
                {Array.from({ length: 3 }).map((_, r) => (
                  <tr key={r}>
                    <td><Skeleton width="55%" /></td>
                    <td><Skeleton width={70} radius={6} /></td>
                    <td><Skeleton width="45%" /></td>
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
          ) : staff.length === 0 ? (
            <EmptyState
              title="No staff yet"
              hint="Create the first staff login above. Each person gets a personal code shown exactly once."
            />
          ) : (
            <table className="grid">
              <thead><tr><th>Name</th><th>Status</th><th>Since</th><th /></tr></thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name ?? "Unnamed"}</td>
                    <td><span className="tag">{s.active ? "Active" : "Deactivated"}</span></td>
                    <td>{new Date(s.createdAt).toLocaleDateString()}</td>
                    <td className="staff-actions">
                      <button type="button" className="btn btn--quiet" onClick={() => onRegenerate(s)} disabled={!s.active}>
                        Regenerate code
                      </button>
                      <button type="button" className="btn btn--quiet" onClick={() => onToggleActive(s)}>
                        {s.active ? "Deactivate" : "Reactivate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel">
          <div className="staff-panel-head"><h2>Recent logins</h2></div>
          {loading ? (
            <Skeleton width="60%" />
          ) : logins.length === 0 ? (
            <EmptyState
              title="No logins recorded yet"
              hint="Every owner and staff sign-in shows up here."
            />
          ) : (
            <table className="grid">
              <thead><tr><th>Who</th><th>When</th></tr></thead>
              <tbody>
                {logins.map((l) => (
                  <tr key={l.id}>
                    <td>{l.actorLabel}</td>
                    <td>{new Date(l.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Modal
        open={reveal !== null}
        onClose={() => setReveal(null)}
        title={reveal ? `Login code for ${reveal.name}` : "Login code"}
        description="Write it down or hand it over now. For safety it is not shown again."
        footer={
          <button type="button" className="btn" onClick={() => setReveal(null)}>
            Done, I saved it
          </button>
        }
      >
        <p className="staff-code" aria-live="polite">{reveal?.code}</p>
        <p className="sub">If the code is lost, use Regenerate code to issue a new one.</p>
      </Modal>
    </>
  );
}
```

- [ ] Typecheck: `npx tsc --noEmit`. Lint: `npm run lint`. Both clean.
- [ ] Manual verification, full end-to-end (dev server via `npm run dev`; if no local owner exists, create one with `npm run admin:create` and enroll TOTP at first sign-in):
  1. As owner, open `http://localhost:3000/admin/staff`. Create "Maya" → a modal shows a 6-digit code exactly once; the Team table lists Maya as Active.
  2. Sign out. On `/admin/login` choose "Staff member? Sign in with your code", enter Maya's code → lands on `/admin`; the side nav shows ONLY Dashboard and Fleet & pricing; no bell; footer reads "Maya · staff".
  3. As Maya, open the planning board (loads), then navigate manually to `http://localhost:3000/admin/settings` → the page shell renders but its data calls return 403 (check the network tab); nothing owner-only is reachable.
  4. Sign out, sign back in as owner → `/admin/staff` "Recent logins" now lists Maya and the owner with readable names and timestamps.
  5. Regenerate Maya's code → old code no longer works at staff sign-in, new one does.
  6. Deactivate Maya → her staff sign-in returns the generic error; reactivate → the current code works again.
  7. Enter 5 garbage codes at the staff sign-in → subsequent attempts (even a correct code) are rejected for 15 minutes; the owner password sign-in still works throughout.
- [ ] Commit:

```bash
git add "src/app/admin/(shell)/staff"
git commit -m "feat(staff): /admin/staff management page with one-time code reveal and recent logins"
```

---

### Task 11: Final verification sweep

**Files:**
- No new files. Fix-forward only if something below fails.

**Interfaces:**
- Consumes: everything above.
- Produces: a green suite and a clean tree ready for plan 09 (Tex port).

**Steps:**

- [ ] Full suite: `npm test -- --no-file-parallelism` — expect ALL tests passing (the pre-wave ~199 plus wave additions plus this plan's new files: staff-schema 2, admin-staff 5, staff-login 5, admin-audit +2).
- [ ] Typecheck: `npx tsc --noEmit` — no errors.
- [ ] Lint: `npm run lint` — no errors.
- [ ] Copy check (dash-free house style in user-facing strings): run

```bash
grep -rn "—" src/app/admin/\(auth\)/login src/app/admin/\(shell\)/staff src/lib/admin/staff.ts src/lib/auth/staff-login.ts src/app/api/admin/staff src/app/api/admin/auth/staff-login
```

Expected: no output. If a hit appears in a user-facing string, rewrite it without the em-dash.
- [ ] Secret hygiene check: confirm no plaintext code can reach logs or audit:

```bash
grep -rn "code" src/app/api/admin/staff --include=route.ts | grep -i "after\|audit"
```

Expected: only the comment lines and `admin.staff_code_regenerated` action name; no `after: { code` anywhere.
- [ ] Role surface check (repeat from Task 6, now final):

```bash
grep -rln 'roles: \["owner", "staff"\]' src/app/api/admin/settings src/app/api/admin/reports src/app/api/admin/audit src/app/api/admin/policies src/app/api/admin/staff 2>/dev/null
```

Expected: no output (owner-only surfaces stayed owner-only).
- [ ] If any fix was needed, commit it:

```bash
git add -A
git commit -m "fix(staff): final verification fixes for workstream 8"
```
