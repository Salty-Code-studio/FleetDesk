# Desk Mode + Telegram Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let FleetDesk deployments run with no payment provider (`PAYMENT_MODE=desk`): the site feeds bookings straight into the back office, managers get a Telegram message with Confirm/Decline buttons (plus email fallback), and a tap flips the booking in the back office automatically.

**Architecture:** A `PAYMENT_MODE` env switch relaxes the Stripe requirement and skips checkout. A channel-agnostic approval core (`src/lib/approval/`) tracks one `approval_requests` row per pending desk booking, with signed single-use tokens for email links. Each deployment runs its own Telegram bot (BotFather, free); the bot webhook points directly at the deployment, taps are authorized by webhook secret + linked manager chat id, and every delivered message is edited in place after the decision. Spec: `docs/superpowers/specs/2026-08-17-desk-mode-chat-approval-design.md`.

**Tech Stack:** Next.js App Router route handlers (`withRoute`), Drizzle + Postgres (PGlite in tests), Zod, Vitest (`pool: "forks"`, setup `src/test/setup.ts`), Resend email infra, Telegram Bot API via `fetch`.

## Global Constraints

- Existing deployments must be untouched: `PAYMENT_MODE` defaults to `online` and every existing test must stay green.
- All user-facing copy: warm, human, and NEVER contains an em-dash (`—`) or double hyphen (`--`). Mo's hard style rule.
- Follow existing codebase patterns exactly: `withRoute` handlers, `Errors.*` for HTTP errors, `logger` (never `console`), best-effort notification contract (a notification failure never breaks a booking), `runtime = "nodejs"` + `dynamic = "force-dynamic"` on API routes.
- Notifications/approval side effects are best-effort: wrap in try/catch, log with `logger.error`, never throw into a booking flow.
- TDD every task: write the failing test first, watch it fail, implement, watch it pass, commit.
- Never log secret values, tokens, or license PII.
- Commit after every task with the exact message given (append the Claude co-author trailer used in this repo).
- Run commands from the repo root: `~/Desktop/SaltyCode/04-Products/saltycodestudio-products/fleetdesk`.
- Test-env gotcha: `src/env.ts` validates and FREEZES at first import. Any test that needs `PAYMENT_MODE=desk` must set `process.env.PAYMENT_MODE = "desk"` at the very top of the test file (before any `@/...` import) and then load app modules with `await import(...)` (top-level await). Static `@/...` imports hoist above the assignment and will lock in `online`. `import { describe... } from "vitest"` is always safe. `pool: "forks"` gives each test FILE its own process, so this never leaks between files.

---

### Task 1: `PAYMENT_MODE` + Telegram env vars, Stripe conditional

**Files:**
- Modify: `src/env.ts`
- Test: `src/test/env-desk-mode.test.ts` (new)

**Interfaces:**
- Produces: `env.PAYMENT_MODE: "online" | "desk"`, `env.TELEGRAM_BOT_TOKEN: string`, `env.TELEGRAM_BOT_USERNAME: string`, `env.TELEGRAM_WEBHOOK_SECRET: string` (all default `""`), and `export const isDeskMode: boolean`. `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` become `""` when unset in desk mode.

- [ ] **Step 1: Write the failing test**

Create `src/test/env-desk-mode.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

/**
 * PAYMENT_MODE=desk must boot without any Stripe env (the whole point of desk
 * mode: clients whose country Stripe does not support). PAYMENT_MODE=online
 * (and the default) must still fail closed without Stripe keys.
 * env.ts freezes on first import, so each case re-imports after vi.resetModules().
 */
describe("env PAYMENT_MODE", () => {
  it("desk mode boots with no Stripe keys and exposes isDeskMode", async () => {
    vi.resetModules();
    process.env.PAYMENT_MODE = "desk";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const mod = await import("@/env");
    expect(mod.env.PAYMENT_MODE).toBe("desk");
    expect(mod.isDeskMode).toBe(true);
    expect(mod.env.STRIPE_SECRET_KEY).toBe("");
  });

  it("online mode still fails closed without Stripe keys", async () => {
    vi.resetModules();
    process.env.PAYMENT_MODE = "online";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    await expect(import("@/env")).rejects.toThrow(/Environment validation failed/);
  });

  it("default mode is online and accepts the test Stripe keys", async () => {
    vi.resetModules();
    delete process.env.PAYMENT_MODE;
    process.env.STRIPE_SECRET_KEY = "sk_test_0000000000000000000000000000";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_testtesttesttesttesttesttest00";
    const mod = await import("@/env");
    expect(mod.env.PAYMENT_MODE).toBe("online");
    expect(mod.isDeskMode).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/env-desk-mode.test.ts`
Expected: FAIL. The desk case throws (Stripe required unconditionally today) and `isDeskMode` does not exist.

- [ ] **Step 3: Implement in `src/env.ts`**

Replace the two required Stripe fields (currently lines 112-121) with optional-with-format versions, add the new vars next to the WHATSAPP block, and extend the existing `.superRefine`:

```ts
    // Payment mode. "online" = Stripe checkout (default, existing behavior).
    // "desk" = no online payment at all: bookings land pending, staff confirm
    // via the chat approval loop, customer pays at pickup. Env (not a DB
    // setting) because it changes WHICH env is required at boot.
    PAYMENT_MODE: z.enum(["online", "desk"]).default("online"),

    // Stripe (payments). REQUIRED when PAYMENT_MODE=online (superRefine below),
    // unused in desk mode. Prefer a RESTRICTED key (rk_) over a secret key (sk_).
    STRIPE_SECRET_KEY: z
      .string()
      .optional()
      .default("")
      .refine((v) => v === "" || (!looksLikePlaceholder(v) && /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(v)), {
        message: "STRIPE_SECRET_KEY must be an sk_/rk_ key",
      }),
    STRIPE_WEBHOOK_SECRET: z
      .string()
      .optional()
      .default("")
      .refine((v) => v === "" || (!looksLikePlaceholder(v) && /^whsec_[A-Za-z0-9]+$/.test(v)), {
        message: "STRIPE_WEBHOOK_SECRET must start with whsec_",
      }),
```

Next to the WHATSAPP_* block add:

```ts
    // Telegram booking-approval bot (desk mode) — OPTIONAL. One bot PER
    // DEPLOYMENT (BotFather). With all three set, managers get Confirm/Decline
    // pings; otherwise the Telegram channel is dormant and email still works.
    // TELEGRAM_WEBHOOK_SECRET is OUR random secret; Telegram echoes it back in
    // the X-Telegram-Bot-Api-Secret-Token header so we can trust the webhook.
    TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
    TELEGRAM_BOT_USERNAME: z.string().optional().default(""),
    TELEGRAM_WEBHOOK_SECRET: z.string().optional().default(""),
```

Extend the existing `.superRefine((v, ctx) => { ... })` (the STORAGE_DRIVER one) with:

```ts
    if (v.PAYMENT_MODE === "online") {
      if (!v.STRIPE_SECRET_KEY) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["STRIPE_SECRET_KEY"], message: "STRIPE_SECRET_KEY is required when PAYMENT_MODE=online" });
      }
      if (!v.STRIPE_WEBHOOK_SECRET) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["STRIPE_WEBHOOK_SECRET"], message: "STRIPE_WEBHOOK_SECRET is required when PAYMENT_MODE=online" });
      }
    }
```

At the bottom, next to `isProd`:

```ts
export const isDeskMode = env.PAYMENT_MODE === "desk";
```

- [ ] **Step 4: Run the new test and the full suite**

Run: `npx vitest run src/test/env-desk-mode.test.ts` → PASS (3 tests).
Run: `npm test` → everything green (setup.ts still sets Stripe keys, default mode online).
Run: `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/env.ts src/test/env-desk-mode.test.ts
git commit -m "feat(env): PAYMENT_MODE=desk boots without Stripe, Telegram bot vars"
```

---

### Task 2: Desk-mode booking behavior (guards, cron, public config)

**Files:**
- Modify: `src/lib/booking/create.ts` (the `payNowCents` guard, lines ~141-149)
- Modify: `src/app/api/bookings/[id]/checkout/route.ts`
- Modify: `src/app/api/webhooks/stripe/route.ts`
- Modify: `src/app/api/cron/expire-holds/route.ts`
- Modify: `src/lib/booking/public.ts` (`PublicBookingConfig` + `publicBookingConfig()`)
- Test: `src/test/desk-mode-booking.test.ts` (new)

**Interfaces:**
- Consumes: `env.PAYMENT_MODE`, `isDeskMode` from Task 1.
- Produces: `publicBookingConfig()` now returns `paymentMode: "online" | "desk"`. Desk-mode booking creation works with zero-charge configurations. Checkout and Stripe webhook routes refuse in desk mode. `expireStaleHolds` is skipped in desk mode (a desk booking has no payment row and would otherwise be cancelled after 30 minutes).

- [ ] **Step 1: Write the failing test**

Create `src/test/desk-mode-booking.test.ts`. IMPORTANT: set the mode BEFORE any `@/` import and use dynamic imports throughout (see Global Constraints):

```ts
process.env.PAYMENT_MODE = "desk";
process.env.CRON_SECRET = "cron-secret-for-tests"; // BEFORE imports: env freezes at first import
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

import { describe, it, expect, beforeAll } from "vitest";

/** Desk mode: the site feeds the back office with NO payment provider at all.
 *  Bookings land pending, checkout is off, and the unpaid-hold expiry cron
 *  must NOT eat desk bookings (they never get a payment row). */

let bookingId = "";

beforeAll(async () => {
  const { runMigrations } = await import("@/lib/db/migrate");
  await runMigrations();
  const { getDb } = await import("@/lib/db/client");
  const { vehicles } = await import("@/lib/db/schema");
  const db = await getDb();
  await db.insert(vehicles).values({
    slug: "desk-car", name: "Desk Car", class: "Economy", status: "active",
    priceDayCents: 5000, priceWeekCents: 30000, priceMonthCents: 100000,
  });
});

function bookingInput(key: string) {
  return {
    vehicleSlug: "desk-car",
    startAt: "2027-03-01T10:00:00-04:00",
    endAt: "2027-03-05T10:00:00-04:00",
    customer: { email: "guest@example.com", name: "Guest One", phone: "+599 785 0000" },
    addOns: [], insuranceTierId: null,
    license: {
      number: "L1234567", country: "NL", dob: "1990-05-05",
      expiresAt: "2030-01-01", fullName: "Guest One",
    },
    acceptTerms: true as const,
    paymentOption: "full" as const,
    youngDriver: false,
    idempotencyKey: key,
  };
}

describe("desk mode booking flow", () => {
  it("creates a pending booking without any Stripe involvement", async () => {
    const { createBooking } = await import("@/lib/booking/create");
    const { arubaNowIso } = await import("@/lib/booking/public");
    const res = await createBooking(bookingInput("desk-key-1"), arubaNowIso());
    bookingId = res.booking.id;
    expect(res.booking.status).toBe("pending");
  });

  it("refuses the Stripe checkout route", async () => {
    const { POST } = await import("@/app/api/bookings/[id]/checkout/route");
    const req = new Request("http://localhost:3000/api/bookings/x/checkout", {
      method: "POST", headers: { origin: "http://localhost:3000", "user-agent": "t" },
    });
    const res = await POST(req, { params: Promise.resolve({ id: bookingId }) });
    expect(res.status).toBe(409);
  });

  it("expire-holds cron does not cancel desk bookings", async () => {
    const { GET } = await import("@/app/api/cron/expire-holds/route");
    // Backdate the booking far beyond the 30-minute unpaid-hold TTL.
    const { getDb } = await import("@/lib/db/client");
    const { bookings } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    await db.update(bookings).set({ createdAt: new Date(Date.now() - 3 * 3600_000) }).where(eq(bookings.id, bookingId));
    const res = await GET(new Request("http://localhost:3000/api/cron/expire-holds", {
      headers: { authorization: "Bearer cron-secret-for-tests" },
    }));
    expect(res.status).toBe(200);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(row!.status).toBe("pending"); // NOT cancelled
  });

  it("public booking config announces the mode", async () => {
    const { publicBookingConfig } = await import("@/lib/booking/public");
    const cfg = await publicBookingConfig();
    expect(cfg.paymentMode).toBe("desk");
  });
});
```

Note: check `src/lib/db/schema/fleet.ts` for the exact NOT NULL vehicle columns and `src/lib/booking/license.ts` for the exact `LicenseSchema` field names before finalizing the seed/input; adjust the two literals above to satisfy them (other tests, e.g. `src/test/move-booking.test.ts`, already seed vehicles and bookings; mirror their literals).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/desk-mode-booking.test.ts`
Expected: FAIL. Checkout returns a Stripe error instead of 409, cron cancels the booking, `paymentMode` is undefined. (The create test may already pass; that is fine.)

- [ ] **Step 3: Implement the guards**

`src/lib/booking/create.ts`: wrap the pay-now guard (keep the comment):

```ts
  // If the owner zeroed both deposit knobs the booking could never be charged
  // (chargeForBooking throws), so reject up front instead of stranding a hold.
  // Desk mode never charges online, so the guard does not apply there.
  if (env.PAYMENT_MODE === "online") {
    const amounts = paymentAmounts(breakdown, input.paymentOption, {
      depositPercent: settings.depositPercent,
      depositMinCents: settings.depositMinCents,
    });
    if (amounts.payNowCents <= 0) {
      throw Errors.badRequest("Online reservation is unavailable right now; please contact us to book");
    }
  }
```

Add `import { env } from "@/env";` to the imports.

`src/app/api/bookings/[id]/checkout/route.ts`: first line inside the handler:

```ts
  if (isDeskMode) throw Errors.conflict("Online payment is not enabled for this site");
```

(import `isDeskMode` from `@/env`, `Errors` from `@/lib/http/errors` if not present).

`src/app/api/webhooks/stripe/route.ts`: first line inside the POST handler:

```ts
  if (isDeskMode) throw Errors.notFound("Not found");
```

`src/app/api/cron/expire-holds/route.ts`:

```ts
  // Desk mode has no online checkout to abandon; expiring "unpaid" pending
  // holds would cancel every real desk booking after 30 minutes.
  const cancelled = isDeskMode ? 0 : await expireStaleHolds(30);
```

(import `isDeskMode` from `@/env`).

`src/lib/booking/public.ts`: add to `PublicBookingConfig`:

```ts
  /** "desk" = no online payment; the wizard skips checkout and shows pay-at-pickup. */
  paymentMode: "online" | "desk";
```

and in `publicBookingConfig()` return `paymentMode: env.PAYMENT_MODE,` (import `env` from `@/env` if the module does not already).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/test/desk-mode-booking.test.ts` → PASS.
Run: `npm test` → full suite green (online default untouched).

- [ ] **Step 5: Commit**

```bash
git add src/lib/booking/create.ts src/app/api/bookings/[id]/checkout/route.ts src/app/api/webhooks/stripe/route.ts src/app/api/cron/expire-holds/route.ts src/lib/booking/public.ts src/test/desk-mode-booking.test.ts
git commit -m "feat(desk-mode): bookings without a payment provider, guarded checkout and cron"
```

---

### Task 3: `approval_requests` schema + manager settings + migration

**Files:**
- Create: `src/lib/db/schema/approvals.ts`
- Modify: `src/lib/db/schema/settings.ts`
- Modify: `src/lib/db/schema/index.ts`
- Modify: `src/lib/admin/settings.ts` (`SettingsPatchSchema`)
- Create: `drizzle/00XX_*.sql` via `npm run db:generate` (do not hand-write)
- Test: `src/test/approval-schema.test.ts` (new)

**Interfaces:**
- Produces: table `approvalRequests` (drizzle export), types `ApprovalRequest = typeof approvalRequests.$inferSelect`, `ApprovalDelivery { channel: "telegram" | "email"; to: string; messageId?: number; sentAt: string }`, `ApprovalManager { name: string; email?: string; inviteCode: string; chatId?: string }`. Settings gains `approvalManagers: ApprovalManager[]`, `approvalReminderHours: number` (default 4), `approvalMaxReminders: number` (default 1). `SettingsPatchSchema` accepts all three.

- [ ] **Step 1: Write the failing test**

Create `src/test/approval-schema.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { approvalRequests, bookings, customers, vehicles } from "@/lib/db/schema";
import { getSettings, patchSettings } from "@/lib/admin/settings";

beforeAll(async () => { await runMigrations(); });

describe("approval schema", () => {
  it("stores an approval request with defaults", async () => {
    const db = await getDb();
    await db.insert(vehicles).values({
      slug: "apv-car", name: "Apv Car", class: "SUV", status: "active",
      priceDayCents: 9000, priceWeekCents: 50000, priceMonthCents: 150000,
    });
    const [v] = await db.select().from(vehicles);
    await db.insert(customers).values({ email: "apv@example.com", name: "Apv", phone: "" });
    const [c] = await db.select().from(customers);
    const [b] = await db.insert(bookings).values({
      vehicleId: v!.id, customerId: c!.id,
      startAt: "2027-04-01T10:00:00-04:00", endAt: "2027-04-03T10:00:00-04:00",
      bufferEndAt: "2027-04-04T10:00:00-04:00",
      status: "pending", priceBreakdown: {}, paymentOption: "full",
      acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "apv-key-1",
    }).returning();
    const [row] = await db.insert(approvalRequests).values({
      bookingId: b!.id, tokenHash: "h", expiresAt: new Date(Date.now() + 1000),
    }).returning();
    expect(row!.status).toBe("open");
    expect(row!.sentTo).toEqual([]);
    expect(row!.reminderCount).toBe(0);
  });

  it("settings carries approval manager config with defaults", async () => {
    const s = await getSettings();
    expect(s.approvalManagers).toEqual([]);
    expect(s.approvalReminderHours).toBe(4);
    expect(s.approvalMaxReminders).toBe(1);
    const updated = await patchSettings({
      approvalManagers: [{ name: "Naomi", email: "naomi@example.com", inviteCode: "code-1234-abcd" }],
      approvalReminderHours: 6,
    });
    expect(updated.approvalManagers[0]!.name).toBe("Naomi");
    expect(updated.approvalReminderHours).toBe(6);
  });
});
```

(Adjust the seed literals to the real NOT NULL columns exactly as in Task 2.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/approval-schema.test.ts`
Expected: FAIL with `approvalRequests` not exported / column does not exist.

- [ ] **Step 3: Create `src/lib/db/schema/approvals.ts`**

```ts
import { pgTable, pgEnum, text, timestamp, uuid, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bookings } from "./bookings";

export const approvalStatus = pgEnum("approval_status", ["open", "confirmed", "declined", "closed"]);

/** One chat/email delivery of an approval ping. messageId lets the Telegram
 *  adapter edit the message in place after the decision. */
export interface ApprovalDelivery {
  channel: "telegram" | "email";
  to: string;
  messageId?: number;
  sentAt: string;
}

/**
 * Internal approval loop for desk-mode bookings (spec 2026-08-17): one OPEN
 * request per pending booking. A manager's tap (Telegram) or click (email)
 * decides it; "closed" means the booking got decided elsewhere (admin) or the
 * request went stale. The message loop is a convenience, never a gate: an
 * unanswered request leaves the booking pending forever.
 */
export const approvalRequests = pgTable("approval_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookingId: uuid("booking_id").notNull().references(() => bookings.id, { onDelete: "cascade" }),
  status: approvalStatus("status").notNull().default("open"),
  // sha256 hex of the signed email-link token (never the token itself).
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  sentTo: jsonb("sent_to").$type<ApprovalDelivery[]>().notNull().default(sql`'[]'::jsonb`),
  reminderCount: integer("reminder_count").notNull().default(0),
  remindedAt: timestamp("reminded_at", { withTimezone: true }),
  decidedBy: text("decided_by"),
  decidedChannel: text("decided_channel"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("approval_requests_open_booking_uq").on(t.bookingId).where(sql`${t.status} = 'open'`),
  index("approval_requests_status_idx").on(t.status),
]);

export type ApprovalRequest = typeof approvalRequests.$inferSelect;
```

- [ ] **Step 4: Extend `src/lib/db/schema/settings.ts`**

Above the `settings` table add:

```ts
/** A back-office manager who may confirm/decline desk-mode bookings. The
 *  inviteCode links their Telegram account (t.me/<bot>?start=<code>); chatId
 *  is set once they tap the invite link. Email is the fallback channel. */
export interface ApprovalManager {
  name: string;
  email?: string;
  inviteCode: string;
  chatId?: string;
}
```

Inside the `settings` table, after `complianceAlertDays`:

```ts
  // Desk-mode approval loop (spec 2026-08-17): who gets the Confirm/Decline
  // pings, how soon to remind, and how many times. Managers double as the
  // inbound allowlist for the Telegram webhook.
  approvalManagers: jsonb("approval_managers").$type<ApprovalManager[]>().notNull().default(sql`'[]'::jsonb`),
  approvalReminderHours: integer("approval_reminder_hours").notNull().default(4),
  approvalMaxReminders: integer("approval_max_reminders").notNull().default(1),
```

`src/lib/db/schema/index.ts`: add `export * from "./approvals";`

- [ ] **Step 5: Extend `SettingsPatchSchema` in `src/lib/admin/settings.ts`**

After `complianceAlertDays`:

```ts
  approvalManagers: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    inviteCode: z.string().trim().regex(/^[A-Za-z0-9_-]{8,64}$/, "invite code must be 8-64 url-safe characters"),
    chatId: z.string().trim().regex(/^-?\d{1,20}$/, "chatId must be a Telegram chat id").optional(),
  }).strict()).max(20).optional(),
  approvalReminderHours: z.number().int().min(1).max(168).optional(),
  approvalMaxReminders: z.number().int().min(0).max(10).optional(),
```

- [ ] **Step 6: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/00XX_*.sql` containing `CREATE TABLE "approval_requests"`, the partial unique index, the `approval_status` enum, and three `ALTER TABLE "settings" ADD COLUMN` lines. Inspect it; never edit generated SQL by hand.

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/test/approval-schema.test.ts` → PASS.
Run: `npm test && npm run typecheck` → green.

- [ ] **Step 8: Commit**

```bash
git add src/lib/db/schema/approvals.ts src/lib/db/schema/settings.ts src/lib/db/schema/index.ts src/lib/admin/settings.ts drizzle/ src/test/approval-schema.test.ts
git commit -m "feat(schema): approval_requests table + approval manager settings"
```

---

### Task 4: Signed email-link tokens

**Files:**
- Create: `src/lib/approval/tokens.ts`
- Test: `src/test/approval-tokens.test.ts` (new)

**Interfaces:**
- Produces: `issueApprovalToken(requestId: string): string`, `verifyApprovalToken(token: string): string | null` (returns the requestId or null), `hashToken(token: string): string` (sha256 hex).

- [ ] **Step 1: Write the failing test**

Create `src/test/approval-tokens.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { issueApprovalToken, verifyApprovalToken, hashToken } from "@/lib/approval/tokens";

const RID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("approval tokens", () => {
  it("round-trips a valid token", () => {
    const t = issueApprovalToken(RID);
    expect(verifyApprovalToken(t)).toBe(RID);
  });
  it("rejects a tampered mac, a tampered id, and garbage", () => {
    const t = issueApprovalToken(RID);
    expect(verifyApprovalToken(t.slice(0, -2) + "aa")).toBeNull();
    expect(verifyApprovalToken("1f8fad5b-d9cb-469f-a165-70867728950e" + t.slice(36))).toBeNull();
    expect(verifyApprovalToken("nonsense")).toBeNull();
    expect(verifyApprovalToken("")).toBeNull();
  });
  it("hashes deterministically and never equals the token", () => {
    const t = issueApprovalToken(RID);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toBe(t);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/approval-tokens.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/lib/approval/tokens.ts`**

```ts
/**
 * Signed single-use tokens for the email Approve/Decline links. Format:
 * "<requestId>.<base64url hmac>". The key is DERIVED from SESSION_SECRET with
 * a fixed context string, so no new secret has to be provisioned; rotating
 * SESSION_SECRET invalidates outstanding links, which is acceptable (7-day
 * expiry, reminders re-issue nothing; the admin can always decide directly).
 * Only the sha256 of the token is stored (tokenHash), never the token.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/env";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function key(): Buffer {
  return createHmac("sha256", env.SESSION_SECRET).update("fleetdesk-approval-tokens-v1").digest();
}

export function issueApprovalToken(requestId: string): string {
  const mac = createHmac("sha256", key()).update(requestId).digest("base64url");
  return `${requestId}.${mac}`;
}

export function verifyApprovalToken(token: string): string | null {
  const dot = token.indexOf(".");
  if (dot !== 36) return null;
  const requestId = token.slice(0, dot);
  if (!UUID_RE.test(requestId)) return null;
  let mac: Buffer;
  try {
    mac = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", key()).update(requestId).digest();
  if (mac.length !== expected.length) return null;
  return timingSafeEqual(mac, expected) ? requestId : null;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/test/approval-tokens.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/approval/tokens.ts src/test/approval-tokens.test.ts
git commit -m "feat(approval): signed single-use tokens for email decision links"
```

---

### Task 5: Approval message builder (with fleet check line)

**Files:**
- Create: `src/lib/approval/message.ts`
- Test: `src/test/approval-message.test.ts` (new)

**Interfaces:**
- Consumes: drizzle tables, `formatDateTime` from `@/lib/time/format`, `siteConfig` from `@/lib/site-config`, the `money` formatting helper used by `src/lib/email/templates.ts` (import it from the same module templates.ts does; check its import line).
- Produces: `buildApprovalMessage(bookingId: string): Promise<ApprovalMessage | null>` with `interface ApprovalMessage { text: string; vehicleName: string; startAt: string; endAt: string; customerName: string; totalLabel: string; fleetLine: string }`.

- [ ] **Step 1: Write the failing test**

Create `src/test/approval-message.test.ts`. Seed two same-class vehicles, one with a conflicting confirmed booking, then build the message for a new pending booking:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { getDb } from "@/lib/db/client";
import { bookings, customers, vehicles } from "@/lib/db/schema";
import { buildApprovalMessage } from "@/lib/approval/message";

let targetBookingId = "";

beforeAll(async () => {
  await runMigrations();
  const db = await getDb();
  const [a] = await db.insert(vehicles).values({
    slug: "msg-a", name: "Yaris A", class: "Economy", status: "active",
    priceDayCents: 5000, priceWeekCents: 30000, priceMonthCents: 100000,
  }).returning();
  const [b] = await db.insert(vehicles).values({
    slug: "msg-b", name: "Yaris B", class: "Economy", status: "active",
    priceDayCents: 5000, priceWeekCents: 30000, priceMonthCents: 100000,
  }).returning();
  await db.insert(customers).values({ email: "msg@example.com", name: "Sarah Jenkins", phone: "+599 785 1111" });
  const [c] = await db.select().from(customers);
  // Vehicle B is taken over the same dates (confirmed) -> only A is free.
  await db.insert(bookings).values({
    vehicleId: b!.id, customerId: c!.id,
    startAt: "2027-05-01T10:00:00-04:00", endAt: "2027-05-06T10:00:00-04:00",
    bufferEndAt: "2027-05-07T10:00:00-04:00", status: "confirmed",
    priceBreakdown: { subtotalCents: 25000, currency: "USD" }, paymentOption: "full",
    acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "msg-key-b",
  });
  const [t] = await db.insert(bookings).values({
    vehicleId: a!.id, customerId: c!.id,
    startAt: "2027-05-02T10:00:00-04:00", endAt: "2027-05-04T10:00:00-04:00",
    bufferEndAt: "2027-05-05T10:00:00-04:00", status: "pending",
    priceBreakdown: { subtotalCents: 10000, currency: "USD" }, paymentOption: "full",
    acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "msg-key-t",
  }).returning();
  targetBookingId = t!.id;
});

describe("buildApprovalMessage", () => {
  it("summarizes the booking and counts same-class availability", async () => {
    const msg = await buildApprovalMessage(targetBookingId);
    expect(msg).not.toBeNull();
    expect(msg!.vehicleName).toBe("Yaris A");
    expect(msg!.customerName).toBe("Sarah Jenkins");
    // B conflicts, A carries only the target booking itself -> 1 of 2 free.
    expect(msg!.fleetLine).toBe("Fleet check: 1 of 2 Economy free on those dates");
    expect(msg!.text).toContain("New booking");
    expect(msg!.text).toContain("Yaris A");
    expect(msg!.text).toContain("pay at pickup");
    expect(msg!.text).toContain(msg!.fleetLine);
    expect(msg!.text).not.toMatch(/—|--/); // Mo's copy rule
  });
  it("returns null for an unknown booking", async () => {
    expect(await buildApprovalMessage("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/approval-message.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/lib/approval/message.ts`**

```ts
/**
 * Builds the internal approval ping from LIVE back-office data, so the manager
 * sees what the back office knows before tapping. The fleet line counts
 * same-class ACTIVE vehicles with no overlapping active booking over the
 * requested dates (same overlap rules as availability: [startAt, bufferEndAt)).
 * Plain text on purpose: it renders identically in Telegram and email.
 */
import { and, eq, gt, inArray, lt, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, customers, vehicles } from "@/lib/db/schema";
import { formatDateTime } from "@/lib/time/format";
import { siteConfig } from "@/lib/site-config";
import type { QuoteBreakdown } from "@/lib/booking/quote";

export interface ApprovalMessage {
  text: string;
  vehicleName: string;
  startAt: string;
  endAt: string;
  customerName: string;
  totalLabel: string;
  fleetLine: string;
}

export async function buildApprovalMessage(bookingId: string): Promise<ApprovalMessage | null> {
  const db = await getDb();
  const [row] = await db.select({
    booking: bookings, vehicle: vehicles,
    customerName: customers.name, customerPhone: customers.phone, customerEmail: customers.email,
  }).from(bookings)
    .innerJoin(vehicles, eq(bookings.vehicleId, vehicles.id))
    .innerJoin(customers, eq(bookings.customerId, customers.id))
    .where(eq(bookings.id, bookingId));
  if (!row) return null;

  const b = row.booking;
  const breakdown = b.priceBreakdown as QuoteBreakdown;
  const totalLabel = formatMoney(breakdown.subtotalCents ?? 0, breakdown.currency ?? "USD");

  const classmates = await db.select({ id: vehicles.id }).from(vehicles)
    .where(and(eq(vehicles.class, row.vehicle.class), eq(vehicles.status, "active")));
  let free = 0;
  for (const v of classmates) {
    const [conflict] = await db.select({ id: bookings.id }).from(bookings)
      .where(and(
        eq(bookings.vehicleId, v.id),
        inArray(bookings.status, ["pending", "confirmed", "picked_up"]),
        lt(bookings.startAt, b.endAt),
        gt(bookings.bufferEndAt, b.startAt),
        ne(bookings.id, b.id),
      )).limit(1);
    if (!conflict) free += 1;
  }
  const fleetLine = `Fleet check: ${free} of ${classmates.length} ${row.vehicle.class} free on those dates`;

  const contact = row.customerPhone || row.customerEmail;
  const text = [
    `New booking · ${siteConfig.siteName}`,
    `${row.vehicle.name} (${row.vehicle.class})`,
    `${formatDateTime(b.startAt)} to ${formatDateTime(b.endAt)}`,
    `${totalLabel} · pay at pickup`,
    `${row.customerName} · ${contact}`,
    fleetLine,
  ].join("\n");

  return { text, vehicleName: row.vehicle.name, startAt: b.startAt, endAt: b.endAt, customerName: row.customerName, totalLabel, fleetLine };
}

function formatMoney(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}
```

(If `src/lib/email/templates.ts` exports its `money` helper, import and use that instead of the local `formatMoney`; if it is module-private, keep the local function.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/test/approval-message.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/approval/message.ts src/test/approval-message.test.ts
git commit -m "feat(approval): booking summary message with live fleet check line"
```

---

### Task 6: Telegram API client + update parsing

**Files:**
- Create: `src/lib/approval/telegram.ts`
- Test: `src/test/approval-telegram.test.ts` (new)

**Interfaces:**
- Consumes: `env.TELEGRAM_BOT_TOKEN`.
- Produces:
  - `telegramConfigured(): boolean`
  - `sendApprovalMessage(chatId: string, text: string, requestId: string): Promise<number | null>` (returns Telegram message_id)
  - `sendText(chatId: string, text: string): Promise<void>`
  - `editMessage(chatId: string, messageId: number, text: string): Promise<void>` (removes the inline keyboard by omitting reply_markup)
  - `answerCallback(callbackQueryId: string, text?: string): Promise<void>`
  - `parseTelegramUpdate(update: unknown): TelegramTap | TelegramStart | null` with
    `interface TelegramTap { kind: "tap"; callbackQueryId: string; chatId: string; fromName: string; messageId: number; requestId: string; action: "confirm" | "decline" }` and
    `interface TelegramStart { kind: "start"; chatId: string; fromName: string; code: string }`

- [ ] **Step 1: Write the failing test**

Create `src/test/approval-telegram.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseTelegramUpdate, sendApprovalMessage } from "@/lib/approval/telegram";

const RID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("parseTelegramUpdate", () => {
  it("parses a Confirm button tap", () => {
    const tap = parseTelegramUpdate({
      update_id: 1,
      callback_query: {
        id: "cbq1", from: { id: 777, first_name: "Naomi" },
        message: { message_id: 42, chat: { id: 777 } },
        data: `apv:${RID}:confirm`,
      },
    });
    expect(tap).toEqual({
      kind: "tap", callbackQueryId: "cbq1", chatId: "777", fromName: "Naomi",
      messageId: 42, requestId: RID, action: "confirm",
    });
  });
  it("parses /start with an invite code", () => {
    const start = parseTelegramUpdate({
      update_id: 2,
      message: { message_id: 1, from: { id: 888, first_name: "Ravi" }, chat: { id: 888 }, text: "/start code-1234-abcd" },
    });
    expect(start).toEqual({ kind: "start", chatId: "888", fromName: "Ravi", code: "code-1234-abcd" });
  });
  it("returns null for junk, malformed callback data, and plain text", () => {
    expect(parseTelegramUpdate(null)).toBeNull();
    expect(parseTelegramUpdate({ update_id: 3 })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 4, callback_query: { id: "x", from: { id: 1 }, message: { message_id: 1, chat: { id: 1 } }, data: "apv:not-a-uuid:confirm" } })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 5, message: { message_id: 1, from: { id: 1, first_name: "A" }, chat: { id: 1 }, text: "hello" } })).toBeNull();
  });
});

describe("sendApprovalMessage", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("posts an inline keyboard and returns the message id", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 }),
    );
    const mid = await sendApprovalMessage("777", "hello", RID);
    expect(mid).toBe(99);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain("/sendMessage");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.chat_id).toBe("777");
    expect(body.reply_markup.inline_keyboard[0]).toEqual([
      { text: "Confirm", callback_data: `apv:${RID}:confirm` },
      { text: "Decline", callback_data: `apv:${RID}:decline` },
    ]);
  });
});
```

Note: `env.TELEGRAM_BOT_TOKEN` is `""` in tests; the client builds the URL anyway (the fetch is stubbed). Tests never hit the network.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/approval-telegram.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/lib/approval/telegram.ts`**

```ts
/**
 * Minimal Telegram Bot API client for the approval loop. One bot PER
 * DEPLOYMENT (created with BotFather); this module only talks OUTBOUND.
 * Inbound updates arrive at /api/webhooks/telegram and are parsed with
 * parseTelegramUpdate (pure, unit-testable). callback_data is capped at 64
 * bytes by Telegram, so buttons carry only "apv:<requestId>:<action>";
 * AUTHORITY comes from the webhook secret header plus the linked manager
 * chat id, never from the button payload.
 */
import { env } from "@/env";

const CALLBACK_RE = /^apv:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(confirm|decline)$/;

export function telegramConfigured(): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN);
}

async function call(method: string, payload: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`telegram ${method} ${res.status}`);
  const data = (await res.json()) as { ok: boolean; result?: unknown };
  if (!data.ok) throw new Error(`telegram ${method} not ok`);
  return data.result;
}

export async function sendApprovalMessage(chatId: string, text: string, requestId: string): Promise<number | null> {
  const result = await call("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [[
        { text: "Confirm", callback_data: `apv:${requestId}:confirm` },
        { text: "Decline", callback_data: `apv:${requestId}:decline` },
      ]],
    },
  });
  const mid = (result as { message_id?: number } | undefined)?.message_id;
  return typeof mid === "number" ? mid : null;
}

export async function sendText(chatId: string, text: string): Promise<void> {
  await call("sendMessage", { chat_id: chatId, text });
}

/** Rewrites a delivered ping after the decision; omitting reply_markup drops
 *  the buttons so late taps have nothing left to press. */
export async function editMessage(chatId: string, messageId: number, text: string): Promise<void> {
  await call("editMessageText", { chat_id: chatId, message_id: messageId, text });
}

export async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
  await call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

export interface TelegramTap {
  kind: "tap";
  callbackQueryId: string;
  chatId: string;
  fromName: string;
  messageId: number;
  requestId: string;
  action: "confirm" | "decline";
}
export interface TelegramStart {
  kind: "start";
  chatId: string;
  fromName: string;
  code: string;
}

export function parseTelegramUpdate(update: unknown): TelegramTap | TelegramStart | null {
  if (!update || typeof update !== "object") return null;
  const u = update as Record<string, unknown>;

  const cq = u.callback_query as {
    id?: unknown; data?: unknown;
    from?: { id?: unknown; first_name?: unknown };
    message?: { message_id?: unknown; chat?: { id?: unknown } };
  } | undefined;
  if (cq && typeof cq.id === "string" && typeof cq.data === "string") {
    const m = CALLBACK_RE.exec(cq.data);
    const chatId = cq.message?.chat?.id;
    const messageId = cq.message?.message_id;
    if (m && (typeof chatId === "number" || typeof chatId === "string") && typeof messageId === "number") {
      return {
        kind: "tap",
        callbackQueryId: cq.id,
        chatId: String(chatId),
        fromName: typeof cq.from?.first_name === "string" ? cq.from.first_name : "Manager",
        messageId,
        requestId: m[1]!,
        action: m[2] as "confirm" | "decline",
      };
    }
    return null;
  }

  const msg = u.message as {
    text?: unknown;
    from?: { first_name?: unknown };
    chat?: { id?: unknown };
  } | undefined;
  if (msg && typeof msg.text === "string" && msg.text.startsWith("/start")) {
    const chatId = msg.chat?.id;
    if (typeof chatId !== "number" && typeof chatId !== "string") return null;
    return {
      kind: "start",
      chatId: String(chatId),
      fromName: typeof msg.from?.first_name === "string" ? msg.from.first_name : "there",
      code: msg.text.slice("/start".length).trim(),
    };
  }
  return null;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/test/approval-telegram.test.ts` → PASS.
Run: `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/approval/telegram.ts src/test/approval-telegram.test.ts
git commit -m "feat(approval): telegram bot client + pure update parser"
```

---

### Task 7: Approval core (create request, apply decision) wired into booking creation

**Files:**
- Create: `src/lib/approval/core.ts`
- Modify: `src/lib/email/templates.ts` (add `approvalDecisionEmail`)
- Modify: `src/app/api/bookings/route.ts` (call `createApprovalRequest` after `notifyNewBooking`)
- Test: `src/test/approval-core.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 3-6 (`approvalRequests`, tokens, `buildApprovalMessage`, telegram client), `getSettings`, `notifyAdmin`, `notifyBookingConfirmed` / `notifyBookingCancelled` from `@/lib/email/notifications`, `audit` from `@/lib/audit`, `sendToMany` from `@/lib/email/send`.
- Produces:
  - `createApprovalRequest(bookingId: string): Promise<void>` (best-effort, no-op unless `PAYMENT_MODE=desk`)
  - `type DecisionAction = "confirm" | "decline"`
  - `interface DecisionActor { name: string; channel: "telegram" | "email" | "admin" }`
  - `type DecisionOutcome = { outcome: "confirmed" | "declined"; bookingId: string; request: ApprovalRequest } | { outcome: "already_handled"; decidedBy: string | null; bookingId: string | null } | { outcome: "expired" } | { outcome: "not_found" }`
  - `applyDecision(requestId: string, action: DecisionAction, actor: DecisionActor): Promise<DecisionOutcome>`
  - `applyDecisionByToken(token: string, action: DecisionAction): Promise<DecisionOutcome>` (verifies signature AND tokenHash match)
  - `approvalDecisionEmail(args: { siteName: string; messageText: string; approveUrl: string; declineUrl: string }): RenderedEmail` in templates.ts

- [ ] **Step 1: Write the failing test**

Create `src/test/approval-core.test.ts`. Must run in desk mode with a stubbed global fetch (Telegram):

```ts
process.env.PAYMENT_MODE = "desk";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
process.env.TELEGRAM_BOT_TOKEN = "123:testtoken";

import { describe, it, expect, beforeAll, vi } from "vitest";

vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
  if (String(url).includes("api.telegram.org")) {
    return new Response(JSON.stringify({ ok: true, result: { message_id: 555 } }), { status: 200 });
  }
  return new Response("{}", { status: 200 });
}));

let bookingId = "";

beforeAll(async () => {
  const { runMigrations } = await import("@/lib/db/migrate");
  await runMigrations();
  const { getDb } = await import("@/lib/db/client");
  const { bookings, customers, vehicles } = await import("@/lib/db/schema");
  const { patchSettings } = await import("@/lib/admin/settings");
  const db = await getDb();
  await patchSettings({
    approvalManagers: [
      { name: "Naomi", inviteCode: "code-naomi-1", chatId: "777", email: "naomi@example.com" },
      { name: "Ravi", inviteCode: "code-ravi-22" }, // not linked, no email
    ],
  });
  const [v] = await db.insert(vehicles).values({
    slug: "core-car", name: "Core Car", class: "SUV", status: "active",
    priceDayCents: 8000, priceWeekCents: 45000, priceMonthCents: 140000,
  }).returning();
  await db.insert(customers).values({ email: "core@example.com", name: "Core Cust", phone: "+599 700 0000" });
  const [c] = await db.select().from(customers);
  const [b] = await db.insert(bookings).values({
    vehicleId: v!.id, customerId: c!.id,
    startAt: "2027-06-01T10:00:00-04:00", endAt: "2027-06-03T10:00:00-04:00",
    bufferEndAt: "2027-06-04T10:00:00-04:00", status: "pending",
    priceBreakdown: { subtotalCents: 16000, currency: "USD" }, paymentOption: "full",
    acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "core-key-1",
  }).returning();
  bookingId = b!.id;
});

describe("approval core", () => {
  it("createApprovalRequest stores the row and records deliveries", async () => {
    const { createApprovalRequest } = await import("@/lib/approval/core");
    const { getDb } = await import("@/lib/db/client");
    const { approvalRequests } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    await createApprovalRequest(bookingId);
    const db = await getDb();
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, bookingId));
    expect(row).toBeDefined();
    expect(row!.status).toBe("open");
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // One telegram delivery (Naomi linked) + one email delivery (Naomi's email).
    const channels = row!.sentTo.map((d) => d.channel).sort();
    expect(channels).toEqual(["email", "telegram"]);
    expect(row!.sentTo.find((d) => d.channel === "telegram")!.messageId).toBe(555);
  });

  it("confirm decision flips the booking, second tap reports already handled", async () => {
    const { applyDecision } = await import("@/lib/approval/core");
    const { getDb } = await import("@/lib/db/client");
    const { approvalRequests, bookings } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, bookingId));
    const first = await applyDecision(row!.id, "confirm", { name: "Naomi", channel: "telegram" });
    expect(first.outcome).toBe("confirmed");
    const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(b!.status).toBe("confirmed");
    const second = await applyDecision(row!.id, "decline", { name: "Ravi", channel: "telegram" });
    expect(second.outcome).toBe("already_handled");
    expect(second.outcome === "already_handled" && second.decidedBy).toBe("Naomi");
  });

  it("applyDecisionByToken verifies signature and hash; decline cancels", async () => {
    const { createApprovalRequest, applyDecisionByToken } = await import("@/lib/approval/core");
    const { issueApprovalToken } = await import("@/lib/approval/tokens");
    const { getDb } = await import("@/lib/db/client");
    const { approvalRequests, bookings, customers, vehicles } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const [v] = await db.select().from(vehicles).where(eq(vehicles.slug, "core-car"));
    const [c] = await db.select().from(customers);
    const [b2] = await db.insert(bookings).values({
      vehicleId: v!.id, customerId: c!.id,
      startAt: "2027-07-01T10:00:00-04:00", endAt: "2027-07-03T10:00:00-04:00",
      bufferEndAt: "2027-07-04T10:00:00-04:00", status: "pending",
      priceBreakdown: { subtotalCents: 16000, currency: "USD" }, paymentOption: "full",
      acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "core-key-2",
    }).returning();
    await createApprovalRequest(b2!.id);
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, b2!.id));
    // A forged token for the right request id but wrong hash must fail:
    // regenerate after tampering the stored hash.
    const good = issueApprovalToken(row!.id);
    const res = await applyDecisionByToken(good, "decline");
    expect(res.outcome).toBe("declined");
    const [after] = await db.select().from(bookings).where(eq(bookings.id, b2!.id));
    expect(after!.status).toBe("cancelled");
    expect((await applyDecisionByToken("garbage", "confirm")).outcome).toBe("not_found");
  });

  it("expired request reports expired and closes", async () => {
    const { applyDecision, createApprovalRequest } = await import("@/lib/approval/core");
    const { getDb } = await import("@/lib/db/client");
    const { approvalRequests, bookings, customers, vehicles } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const [v] = await db.select().from(vehicles).where(eq(vehicles.slug, "core-car"));
    const [c] = await db.select().from(customers);
    const [b3] = await db.insert(bookings).values({
      vehicleId: v!.id, customerId: c!.id,
      startAt: "2027-08-01T10:00:00-04:00", endAt: "2027-08-03T10:00:00-04:00",
      bufferEndAt: "2027-08-04T10:00:00-04:00", status: "pending",
      priceBreakdown: { subtotalCents: 16000, currency: "USD" }, paymentOption: "full",
      acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "core-key-3",
    }).returning();
    await createApprovalRequest(b3!.id);
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, b3!.id));
    await db.update(approvalRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approvalRequests.id, row!.id));
    const res = await applyDecision(row!.id, "confirm", { name: "Naomi", channel: "telegram" });
    expect(res.outcome).toBe("expired");
    const [after] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, row!.id));
    expect(after!.status).toBe("closed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/approval-core.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Add `approvalDecisionEmail` to `src/lib/email/templates.ts`**

Follow the existing `RenderedEmail`/`shell` pattern in that file:

```ts
export function approvalDecisionEmail(args: { siteName: string; messageText: string; approveUrl: string; declineUrl: string }): RenderedEmail {
  const lines = args.messageText.split("\n").map((l) => `${l}<br>`).join("");
  return {
    subject: `Booking to confirm at ${args.siteName}`,
    html: shell("Booking to confirm", `
      <p>A new booking came in and is waiting for a quick yes or no.</p>
      <p>${lines}</p>
      <p>
        <a href="${args.approveUrl}" style="display:inline-block;padding:10px 18px;background:#16a34a;color:#fff;border-radius:6px;text-decoration:none;margin-right:8px">Review and confirm</a>
        <a href="${args.declineUrl}" style="display:inline-block;padding:10px 18px;background:#dc2626;color:#fff;border-radius:6px;text-decoration:none">Review and decline</a>
      </p>
      <p>The buttons open a small review page first, so nothing happens by accident. If the booking was already handled you will see who did it.</p>`),
  };
}
```

(Adapt the `shell(...)` call to the file's exact helper signature; keep inline styles consistent with neighboring templates.)

- [ ] **Step 4: Implement `src/lib/approval/core.ts`**

```ts
/**
 * The channel-agnostic approval loop (spec 2026-08-17). createApprovalRequest
 * is BEST-EFFORT: it runs after desk-mode booking creation and must never
 * break it. applyDecision is the single decision funnel for every channel
 * (telegram tap, email link, admin button): row lock + guarded status flip =
 * first tap wins, everyone else gets an honest "already handled by X".
 */
import { and, eq } from "drizzle-orm";
import { env } from "@/env";
import { getDb } from "@/lib/db/client";
import { approvalRequests, bookings, type ApprovalDelivery, type ApprovalRequest } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";
import { buildApprovalMessage } from "@/lib/approval/message";
import { issueApprovalToken, verifyApprovalToken, hashToken } from "@/lib/approval/tokens";
import { telegramConfigured, sendApprovalMessage } from "@/lib/approval/telegram";
import { approvalDecisionEmail } from "@/lib/email/templates";
import { sendToMany } from "@/lib/email/send";
import { notifyBookingConfirmed, notifyBookingCancelled } from "@/lib/email/notifications";
import { notifyAdmin } from "@/lib/notify";
import { audit } from "@/lib/audit";
import { siteConfig } from "@/lib/site-config";
import { logger } from "@/lib/logger";

const TOKEN_TTL_MS = 7 * 86_400_000;

export type DecisionAction = "confirm" | "decline";
export interface DecisionActor { name: string; channel: "telegram" | "email" | "admin" }
export type DecisionOutcome =
  | { outcome: "confirmed" | "declined"; bookingId: string; request: ApprovalRequest }
  | { outcome: "already_handled"; decidedBy: string | null; bookingId: string | null }
  | { outcome: "expired" }
  | { outcome: "not_found" };

export async function createApprovalRequest(bookingId: string): Promise<void> {
  try {
    if (env.PAYMENT_MODE !== "desk") return;
    const msg = await buildApprovalMessage(bookingId);
    if (!msg) return;
    const db = await getDb();
    const [request] = await db.insert(approvalRequests).values({
      bookingId,
      tokenHash: "issuing",
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    }).returning();
    if (!request) return;
    const token = issueApprovalToken(request.id);
    const settings = await getSettings();
    const deliveries: ApprovalDelivery[] = [];

    if (telegramConfigured()) {
      for (const m of settings.approvalManagers.filter((m) => m.chatId)) {
        try {
          const messageId = await sendApprovalMessage(m.chatId!, msg.text, request.id);
          deliveries.push({ channel: "telegram", to: m.chatId!, messageId: messageId ?? undefined, sentAt: new Date().toISOString() });
        } catch (e) {
          logger.error("approval_telegram_send_failed", { bookingId, chatId: m.chatId, error: (e as Error).message });
        }
      }
    }

    const emails = settings.approvalManagers.map((m) => m.email).filter((e): e is string => Boolean(e));
    if (emails.length) {
      const approveUrl = `${env.APP_ORIGIN}/approve/${token}?action=confirm`;
      const declineUrl = `${env.APP_ORIGIN}/approve/${token}?action=decline`;
      await sendToMany(emails, (to) => ({
        to, type: "approval_decision",
        ...approvalDecisionEmail({ siteName: siteConfig.siteName, messageText: msg.text, approveUrl, declineUrl }),
      }));
      for (const to of emails) deliveries.push({ channel: "email", to, sentAt: new Date().toISOString() });
    }

    await db.update(approvalRequests)
      .set({ tokenHash: hashToken(token), sentTo: deliveries, updatedAt: new Date() })
      .where(eq(approvalRequests.id, request.id));

    await notifyAdmin({
      level: "info", type: "approval.requested", title: "Booking waiting for approval",
      body: msg.fleetLine, bookingId,
    });
  } catch (e) {
    logger.error("approval_request_failed", { bookingId, error: (e as Error).message });
  }
}

export async function applyDecision(requestId: string, action: DecisionAction, actor: DecisionActor): Promise<DecisionOutcome> {
  const db = await getDb();
  const result = await db.transaction(async (tx): Promise<DecisionOutcome> => {
    const [row] = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, requestId)).for("update");
    if (!row) return { outcome: "not_found" };
    if (row.status !== "open") return { outcome: "already_handled", decidedBy: row.decidedBy, bookingId: row.bookingId };
    if (row.expiresAt.getTime() < Date.now()) {
      await tx.update(approvalRequests).set({ status: "closed", updatedAt: new Date() }).where(eq(approvalRequests.id, requestId));
      return { outcome: "expired" };
    }
    const to = action === "confirm" ? "confirmed" : "cancelled";
    const flipped = await tx.update(bookings)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(bookings.id, row.bookingId), eq(bookings.status, "pending")))
      .returning({ id: bookings.id });
    if (flipped.length === 0) {
      // Someone decided the booking elsewhere (admin) while the ping was out.
      await tx.update(approvalRequests).set({ status: "closed", updatedAt: new Date() }).where(eq(approvalRequests.id, requestId));
      return { outcome: "already_handled", decidedBy: null, bookingId: row.bookingId };
    }
    const [updated] = await tx.update(approvalRequests).set({
      status: action === "confirm" ? "confirmed" : "declined",
      decidedBy: actor.name, decidedChannel: actor.channel, decidedAt: new Date(), updatedAt: new Date(),
    }).where(eq(approvalRequests.id, requestId)).returning();
    return { outcome: action === "confirm" ? "confirmed" : "declined", bookingId: row.bookingId, request: updated! };
  });

  if (result.outcome === "confirmed") {
    await notifyBookingConfirmed(result.bookingId).catch(() => undefined);
    await audit({ actor: `approval:${actor.name}`, action: "approval.confirmed", entity: "booking", entityId: result.bookingId, after: { channel: actor.channel } });
  } else if (result.outcome === "declined") {
    await notifyBookingCancelled(result.bookingId, { refunded: false, refundCents: 0 }).catch(() => undefined);
    await audit({ actor: `approval:${actor.name}`, action: "approval.declined", entity: "booking", entityId: result.bookingId, after: { channel: actor.channel } });
  }
  return result;
}

/** Email-link entry: verifies the HMAC signature AND that the token matches
 *  the stored hash (constant-format sha256 compare) before deciding. */
export async function applyDecisionByToken(token: string, action: DecisionAction): Promise<DecisionOutcome> {
  const requestId = verifyApprovalToken(token);
  if (!requestId) return { outcome: "not_found" };
  const db = await getDb();
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, requestId));
  if (!row || row.tokenHash !== hashToken(token)) return { outcome: "not_found" };
  return applyDecision(requestId, action, { name: "Email approver", channel: "email" });
}

/** Read a request plus enough booking context for the email review page. */
export async function getApprovalSummary(token: string): Promise<{ request: ApprovalRequest; message: string } | null> {
  const requestId = verifyApprovalToken(token);
  if (!requestId) return null;
  const db = await getDb();
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, requestId));
  if (!row || row.tokenHash !== hashToken(token)) return null;
  const msg = await buildApprovalMessage(row.bookingId);
  return msg ? { request: row, message: msg.text } : null;
}
```

- [ ] **Step 5: Wire into `src/app/api/bookings/route.ts`**

```ts
import { createApprovalRequest } from "@/lib/approval/core";
```

and after the `notifyNewBooking` line:

```ts
  if (!replayed) await createApprovalRequest(booking.id); // desk-mode chat approval, best-effort
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/test/approval-core.test.ts` → PASS.
Run: `npm test && npm run typecheck` → green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/approval/core.ts src/lib/email/templates.ts src/app/api/bookings/route.ts src/test/approval-core.test.ts
git commit -m "feat(approval): request creation + first-tap-wins decision core"
```

---

### Task 8: Telegram webhook route (linking + taps + message editing) and setup script

**Files:**
- Create: `src/lib/approval/linking.ts`
- Create: `src/lib/approval/broadcast.ts`
- Create: `src/app/api/webhooks/telegram/route.ts`
- Create: `scripts/telegram-setup.ts`
- Modify: `package.json` (add script `"telegram:setup": "node --import tsx --env-file-if-exists=.env.local scripts/telegram-setup.ts"`)
- Test: `src/test/telegram-webhook.test.ts` (new)

**Interfaces:**
- Consumes: `parseTelegramUpdate`, `applyDecision`, `answerCallback`, `editMessage`, `sendText`, settings managers.
- Produces:
  - `linkManagerChat(code: string, chatId: string): Promise<ApprovalManager | null>` (read-modify-write on the settings row; returns the linked manager or null)
  - `managerByChatId(chatId: string): Promise<ApprovalManager | null>`
  - `broadcastDecision(requestId: string): Promise<void>` (edits every telegram delivery of the request to `<message text>\n\n<Confirmed|Declined> by <name>`, buttons removed; best-effort)
  - `POST /api/webhooks/telegram` route behavior as specced.

- [ ] **Step 1: Write the failing test**

Create `src/test/telegram-webhook.test.ts`:

```ts
process.env.PAYMENT_MODE = "desk";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
process.env.TELEGRAM_BOT_TOKEN = "123:testtoken";
process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret-1";

import { describe, it, expect, beforeAll, vi } from "vitest";

const telegramCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes("api.telegram.org")) {
    telegramCalls.push({ method: u.split("/").pop()!, body: JSON.parse((init?.body as string) ?? "{}") });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 700 } }), { status: 200 });
  }
  return new Response("{}", { status: 200 });
}));

let requestId = "";
let bookingId = "";

function hook(update: unknown, secret = "hook-secret-1") {
  return new Request("http://localhost:3000/api/webhooks/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret, "user-agent": "tg" },
    body: JSON.stringify(update),
  });
}

beforeAll(async () => {
  const { runMigrations } = await import("@/lib/db/migrate");
  await runMigrations();
  const { getDb } = await import("@/lib/db/client");
  const { approvalRequests, bookings, customers, vehicles } = await import("@/lib/db/schema");
  const { patchSettings } = await import("@/lib/admin/settings");
  const { createApprovalRequest } = await import("@/lib/approval/core");
  const { eq } = await import("drizzle-orm");
  await patchSettings({
    approvalManagers: [
      { name: "Naomi", inviteCode: "code-naomi-1", chatId: "777" },
      { name: "Ravi", inviteCode: "code-ravi-22" },
    ],
  });
  const db = await getDb();
  const [v] = await db.insert(vehicles).values({
    slug: "tg-car", name: "TG Car", class: "Jeep", status: "active",
    priceDayCents: 7000, priceWeekCents: 40000, priceMonthCents: 120000,
  }).returning();
  await db.insert(customers).values({ email: "tg@example.com", name: "TG Cust", phone: "" });
  const [c] = await db.select().from(customers);
  const [b] = await db.insert(bookings).values({
    vehicleId: v!.id, customerId: c!.id,
    startAt: "2027-09-01T10:00:00-04:00", endAt: "2027-09-03T10:00:00-04:00",
    bufferEndAt: "2027-09-04T10:00:00-04:00", status: "pending",
    priceBreakdown: { subtotalCents: 14000, currency: "USD" }, paymentOption: "full",
    acceptedPolicyVersion: 0, acceptedAt: new Date(), idempotencyKey: "tg-key-1",
  }).returning();
  bookingId = b!.id;
  await createApprovalRequest(bookingId);
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, bookingId));
  requestId = row!.id;
});

describe("POST /api/webhooks/telegram", () => {
  it("rejects a wrong secret without touching anything", async () => {
    const { POST } = await import("@/app/api/webhooks/telegram/route");
    const res = await POST(hook({ update_id: 1 }, "wrong"), { params: Promise.resolve({}) });
    expect(res.status).toBe(404);
  });

  it("links a manager via /start invite code", async () => {
    const { POST } = await import("@/app/api/webhooks/telegram/route");
    const res = await POST(hook({
      update_id: 2,
      message: { message_id: 1, from: { id: 888, first_name: "Ravi" }, chat: { id: 888 }, text: "/start code-ravi-22" },
    }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const { getSettings } = await import("@/lib/admin/settings");
    const s = await getSettings();
    expect(s.approvalManagers.find((m) => m.name === "Ravi")!.chatId).toBe("888");
    // And the bot replied something warm to Ravi's chat.
    const reply = telegramCalls.find((c) => c.method === "sendMessage" && c.body.chat_id === "888");
    expect(reply).toBeDefined();
  });

  it("ignores taps from unknown chats", async () => {
    const { POST } = await import("@/app/api/webhooks/telegram/route");
    const res = await POST(hook({
      update_id: 3,
      callback_query: { id: "cb-x", from: { id: 999, first_name: "Stranger" }, message: { message_id: 5, chat: { id: 999 } }, data: `apv:${requestId}:confirm` },
    }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const { getDb } = await import("@/lib/db/client");
    const { bookings } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(b!.status).toBe("pending"); // untouched
  });

  it("a linked manager's Confirm tap flips the booking and edits the pings", async () => {
    telegramCalls.length = 0;
    const { POST } = await import("@/app/api/webhooks/telegram/route");
    const res = await POST(hook({
      update_id: 4,
      callback_query: { id: "cb-1", from: { id: 777, first_name: "Naomi" }, message: { message_id: 700, chat: { id: 777 } }, data: `apv:${requestId}:confirm` },
    }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const { getDb } = await import("@/lib/db/client");
    const { bookings } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(b!.status).toBe("confirmed");
    expect(telegramCalls.some((c) => c.method === "answerCallbackQuery")).toBe(true);
    const edit = telegramCalls.find((c) => c.method === "editMessageText");
    expect(edit).toBeDefined();
    expect(String(edit!.body.text)).toContain("Confirmed by Naomi");
  });

  it("a second tap answers already handled", async () => {
    const { POST } = await import("@/app/api/webhooks/telegram/route");
    telegramCalls.length = 0;
    await POST(hook({
      update_id: 5,
      callback_query: { id: "cb-2", from: { id: 888, first_name: "Ravi" }, message: { message_id: 701, chat: { id: 888 } }, data: `apv:${requestId}:decline` },
    }), { params: Promise.resolve({}) });
    const answer = telegramCalls.find((c) => c.method === "answerCallbackQuery");
    expect(String(answer!.body.text)).toContain("Already handled by Naomi");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/telegram-webhook.test.ts`
Expected: FAIL, route module not found.

- [ ] **Step 3: Implement `src/lib/approval/linking.ts`**

```ts
/**
 * Telegram account linking. Adding a manager in settings generates an invite
 * code; the manager taps t.me/<bot>?start=<code> and the /start handler here
 * binds their chat id. Managers with a chatId are BOTH the ping recipients and
 * the inbound allowlist.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { settings, type ApprovalManager } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";

export async function linkManagerChat(code: string, chatId: string): Promise<ApprovalManager | null> {
  if (!code) return null;
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).where(eq(settings.id, 1)).for("update");
    if (!row) return null;
    const managers = row.approvalManagers;
    const idx = managers.findIndex((m) => m.inviteCode === code);
    if (idx === -1) return null;
    const next = managers.map((m, i) => (i === idx ? { ...m, chatId } : m));
    await tx.update(settings).set({ approvalManagers: next, updatedAt: new Date() }).where(eq(settings.id, 1));
    return next[idx]!;
  });
}

export async function managerByChatId(chatId: string): Promise<ApprovalManager | null> {
  const s = await getSettings();
  return s.approvalManagers.find((m) => m.chatId === chatId) ?? null;
}
```

- [ ] **Step 4: Implement `src/lib/approval/broadcast.ts`**

```ts
/**
 * After a decision, rewrite every delivered Telegram ping in place: summary
 * text plus "Confirmed/Declined by X", inline keyboard removed, so every
 * manager's copy shows the outcome and late taps have no buttons. Best-effort:
 * a failed edit is logged and skipped (the back office is already correct).
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { approvalRequests } from "@/lib/db/schema";
import { buildApprovalMessage } from "@/lib/approval/message";
import { editMessage, telegramConfigured } from "@/lib/approval/telegram";
import { logger } from "@/lib/logger";

export async function broadcastDecision(requestId: string): Promise<void> {
  try {
    if (!telegramConfigured()) return;
    const db = await getDb();
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, requestId));
    if (!row || (row.status !== "confirmed" && row.status !== "declined")) return;
    const verb = row.status === "confirmed" ? "Confirmed" : "Declined";
    const by = row.decidedBy ?? "the team";
    const msg = await buildApprovalMessage(row.bookingId);
    const base = msg?.text ?? "Booking update";
    for (const d of row.sentTo) {
      if (d.channel !== "telegram" || typeof d.messageId !== "number") continue;
      try {
        await editMessage(d.to, d.messageId, `${base}\n\n${verb} by ${by}`);
      } catch (e) {
        logger.error("approval_broadcast_edit_failed", { requestId, chatId: d.to, error: (e as Error).message });
      }
    }
  } catch (e) {
    logger.error("approval_broadcast_failed", { requestId, error: (e as Error).message });
  }
}
```

- [ ] **Step 5: Implement `src/app/api/webhooks/telegram/route.ts`**

```ts
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { Errors } from "@/lib/http/errors";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { env } from "@/env";
import { parseTelegramUpdate, answerCallback, sendText } from "@/lib/approval/telegram";
import { linkManagerChat, managerByChatId } from "@/lib/approval/linking";
import { applyDecision } from "@/lib/approval/core";
import { broadcastDecision } from "@/lib/approval/broadcast";
import { siteConfig } from "@/lib/site-config";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/telegram — the deployment's own bot webhook. Trust model:
 * the X-Telegram-Bot-Api-Secret-Token header must equal OUR random secret
 * (set via scripts/telegram-setup.ts), and a tap only counts when the chat id
 * belongs to a linked manager. Always 200 fast on handled updates so Telegram
 * does not retry into a loop; unknown senders are answered politely and logged.
 */
export const POST = withRoute(async (req) => {
  if (!env.TELEGRAM_WEBHOOK_SECRET || req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    throw Errors.notFound("Not found"); // do not reveal the endpoint
  }
  await enforceRateLimit(req, "global", "public");
  const update = await req.json().catch(() => null);
  const parsed = parseTelegramUpdate(update);
  if (!parsed) return json({ ok: true }, req);

  if (parsed.kind === "start") {
    const manager = await linkManagerChat(parsed.code, parsed.chatId);
    const reply = manager
      ? `You're linked, ${manager.name}. Booking approvals for ${siteConfig.siteName} will arrive here.`
      : `This bot only serves ${siteConfig.siteName} staff. Ask your admin for an invite link.`;
    await sendText(parsed.chatId, reply).catch((e) => logger.error("telegram_start_reply_failed", { error: (e as Error).message }));
    return json({ ok: true }, req);
  }

  const manager = await managerByChatId(parsed.chatId);
  if (!manager) {
    logger.warn("telegram_tap_unknown_chat", { chatId: parsed.chatId });
    await answerCallback(parsed.callbackQueryId, "Not authorized.").catch(() => undefined);
    return json({ ok: true }, req);
  }

  const result = await applyDecision(parsed.requestId, parsed.action, { name: manager.name, channel: "telegram" });
  if (result.outcome === "confirmed" || result.outcome === "declined") {
    await answerCallback(parsed.callbackQueryId, result.outcome === "confirmed" ? "Booking confirmed." : "Booking declined.").catch(() => undefined);
    await broadcastDecision(parsed.requestId);
  } else if (result.outcome === "already_handled") {
    await answerCallback(parsed.callbackQueryId, `Already handled by ${result.decidedBy ?? "the team"}.`).catch(() => undefined);
  } else if (result.outcome === "expired") {
    await answerCallback(parsed.callbackQueryId, "This one expired. Please use the admin.").catch(() => undefined);
  } else {
    await answerCallback(parsed.callbackQueryId, "Unknown booking. Please use the admin.").catch(() => undefined);
  }
  return json({ ok: true }, req);
});
```

- [ ] **Step 6: Implement `scripts/telegram-setup.ts`**

Mirror the import style of `scripts/check-env.ts` (same tsx runner). Content:

```ts
/**
 * One-time per deployment: points the bot's webhook at THIS deployment with
 * our secret. Run AFTER setting TELEGRAM_BOT_TOKEN + TELEGRAM_WEBHOOK_SECRET
 * (+ APP_ORIGIN) in the environment: npm run telegram:setup
 */
import { env } from "../src/env";

async function main(): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET first.");
    process.exit(1);
  }
  const base = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const me = await (await fetch(`${base}/getMe`)).json();
  console.log("Bot:", JSON.stringify(me.result ?? me));
  const hook = await (await fetch(`${base}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `${env.APP_ORIGIN}/api/webhooks/telegram`,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
    }),
  })).json();
  console.log("setWebhook:", JSON.stringify(hook));
}

void main();
```

(If `scripts/check-env.ts` imports via an alias or different relative path, copy its exact convention.) Add the npm script to `package.json`.

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/test/telegram-webhook.test.ts` → PASS.
Run: `npm test && npm run typecheck` → green.

- [ ] **Step 8: Commit**

```bash
git add src/lib/approval/linking.ts src/lib/approval/broadcast.ts src/app/api/webhooks/telegram/route.ts scripts/telegram-setup.ts package.json src/test/telegram-webhook.test.ts
git commit -m "feat(approval): telegram webhook with invite linking, taps, in-place edits"
```

---

### Task 9: Email decision endpoints + review page

**Files:**
- Create: `src/app/api/approval/[token]/route.ts` (GET summary)
- Create: `src/app/api/approval/decide/route.ts` (POST decision)
- Create: `src/app/(public)/approve/[token]/page.tsx`
- Test: `src/test/approval-email-decision.test.ts` (new)

**Interfaces:**
- Consumes: `getApprovalSummary`, `applyDecisionByToken` from core, `broadcastDecision` from Task 8, `enforceRateLimit` + `enforceOrigin` patterns from `src/app/api/bookings/route.ts`.
- Produces: `GET /api/approval/:token` → `{ status, decidedBy, message }` or 404. `POST /api/approval/decide` body `{ token, action }` → `{ outcome, decidedBy? }`. A public review page at `/approve/[token]` with one real button per action (never mutate on GET; mail scanners follow links).

- [ ] **Step 1: Write the failing test**

Create `src/test/approval-email-decision.test.ts` (desk-mode header block + stubbed fetch exactly like Task 8's test). Seed one pending booking + approval request via `createApprovalRequest`, capture the token by regenerating it: `issueApprovalToken(requestId)` (same deterministic HMAC). Then:

```ts
describe("email decision endpoints", () => {
  it("GET summary returns the message for a valid token and 404 for garbage", async () => {
    const { GET } = await import("@/app/api/approval/[token]/route");
    const ok = await GET(new Request("http://localhost:3000/api/approval/x", { headers: { "user-agent": "t" } }), { params: Promise.resolve({ token }) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("open");
    const bad = await GET(new Request("http://localhost:3000/api/approval/x", { headers: { "user-agent": "t" } }), { params: Promise.resolve({ token: "garbage" }) });
    expect(bad.status).toBe(404);
  });

  it("POST decide confirms the booking once, then reports already handled", async () => {
    const { POST } = await import("@/app/api/approval/decide/route");
    const decide = (action: string) => POST(new Request("http://localhost:3000/api/approval/decide", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", "user-agent": "t" },
      body: JSON.stringify({ token, action }),
    }), { params: Promise.resolve({}) });
    const first = await decide("confirm");
    expect((await first.json()).outcome).toBe("confirmed");
    const second = await decide("decline");
    expect((await second.json()).outcome).toBe("already_handled");
    const { getDb } = await import("@/lib/db/client");
    const { bookings } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(b!.status).toBe("confirmed");
  });
});
```

(Write the full seed block; copy the beforeAll from Task 8's test with fresh slugs/keys.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/approval-email-decision.test.ts`
Expected: FAIL, route modules not found.

- [ ] **Step 3: Implement `src/app/api/approval/[token]/route.ts`**

```ts
import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { Errors } from "@/lib/http/errors";
import { getApprovalSummary } from "@/lib/approval/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ token: z.string().min(10).max(200) });

/** GET /api/approval/:token — token-gated read for the email review page. */
export const GET = withRoute(async (req, { params }) => {
  await enforceRateLimit(req, "global", "approval");
  const { token } = parseParams(await params, ParamsSchema);
  const summary = await getApprovalSummary(token);
  if (!summary) throw Errors.notFound("This approval link is not valid");
  return json({
    status: summary.request.status,
    decidedBy: summary.request.decidedBy,
    message: summary.message,
  }, req);
});
```

- [ ] **Step 4: Implement `src/app/api/approval/decide/route.ts`**

```ts
import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { enforceOrigin } from "@/lib/auth/csrf";
import { applyDecisionByToken } from "@/lib/approval/core";
import { broadcastDecision } from "@/lib/approval/broadcast";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  token: z.string().min(10).max(200),
  action: z.enum(["confirm", "decline"]),
}).strict();

/** POST /api/approval/decide — the email review page's real mutation. POST on
 *  purpose: mail scanners follow GET links and must never decide a booking. */
export const POST = withRoute(async (req) => {
  enforceOrigin(req);
  await enforceRateLimit(req, "global", "approval");
  const { token, action } = await parseJsonBody(req, BodySchema);
  const result = await applyDecisionByToken(token, action);
  if (result.outcome === "confirmed" || result.outcome === "declined") {
    await broadcastDecision(result.request.id);
  }
  return json({
    outcome: result.outcome,
    decidedBy: result.outcome === "already_handled" ? result.decidedBy : undefined,
  }, req);
});
```

- [ ] **Step 5: Implement `src/app/(public)/approve/[token]/page.tsx`**

Client component. Look at `src/app/(public)/book/confirmation/page.tsx` first and mirror its styling/layout conventions (same wrapper classes). Behavior:

```tsx
"use client";

import { use, useEffect, useState } from "react";

interface Summary { status: string; decidedBy: string | null; message: string }

/** Email-link review page: shows the booking summary and asks for one real
 *  click. Links never mutate (mail scanners follow them); this page's POST is
 *  the actual decision. */
export default function ApprovePage({ params, searchParams }: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ action?: string }>;
}) {
  const { token } = use(params);
  const { action } = use(searchParams);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "gone" | "done" | "busy">("loading");
  const [outcome, setOutcome] = useState<{ outcome: string; decidedBy?: string } | null>(null);

  useEffect(() => {
    fetch(`/api/approval/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (!r.ok) { setState("gone"); return; }
        setSummary(await r.json()); setState("ready");
      })
      .catch(() => setState("gone"));
  }, [token]);

  async function decide(a: "confirm" | "decline") {
    setState("busy");
    const r = await fetch("/api/approval/decide", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, action: a }),
    });
    setOutcome(r.ok ? await r.json() : { outcome: "not_found" });
    setState("done");
  }

  // Render states:
  // loading -> spinner text; gone -> "This link is not valid anymore. Open the admin to manage bookings."
  // ready -> <pre-line summary.message> + if summary.status !== "open": "Already handled by {decidedBy}."
  //          else two buttons: Confirm booking / Decline booking, the one matching ?action= visually primary.
  // done -> outcome copy: confirmed -> "Done. The booking is confirmed and the customer got their email."
  //         declined -> "Done. The booking is declined and the dates are free again."
  //         already_handled -> "Already handled by {decidedBy ?? "the team"}. Nothing else to do."
  //         expired/not_found -> "This link expired. Open the admin to manage the booking."
  return ( /* implement with the confirmation page's card layout */ );
}
```

Write the full JSX (no placeholder): a centered card, the message rendered with `whiteSpace: "pre-line"`, two `<button>` elements calling `decide`, disabled while `busy`. Keep all copy exactly as in the comments above; no em-dashes.

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/test/approval-email-decision.test.ts` → PASS.
Run: `npm test && npm run typecheck` → green.

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/approval" "src/app/(public)/approve" src/test/approval-email-decision.test.ts
git commit -m "feat(approval): email decision endpoints + scanner-safe review page"
```

---

### Task 10: Admin confirm route + reminder cron

**Files:**
- Create: `src/lib/admin/confirm-booking.ts`
- Create: `src/app/api/admin/bookings/[id]/confirm/route.ts`
- Create: `src/lib/approval/reminders.ts`
- Create: `src/app/api/cron/approval-reminders/route.ts`
- Modify: `vercel.json` (add cron)
- Test: `src/test/approval-admin-reminders.test.ts` (new)

**Interfaces:**
- Consumes: `applyDecision`, `broadcastDecision`, `buildApprovalMessage`, telegram send, `mutate` from `@/lib/admin/guard` (mirror `move/route.ts`), `notifyBookingConfirmed`.
- Produces:
  - `confirmBookingAdmin(id: string, adminName: string): Promise<{ id: string; status: string }>`: if an open approval request exists, routes through `applyDecision(requestId, "confirm", { name: adminName, channel: "admin" })` + `broadcastDecision`; otherwise a guarded `pending -> confirmed` flip + `notifyBookingConfirmed`. Throws `Errors.conflict` when the booking is not pending.
  - `POST /api/admin/bookings/:id/confirm` (roles owner + staff).
  - `runApprovalReminders(now?: Date): Promise<{ reminded: number; closed: number }>`: janitor closes open requests whose booking left `pending`; reminder re-pings Telegram (prefix `"Reminder: "`) for open requests still pending, unexpired, `reminderCount < settings.approvalMaxReminders`, and `(remindedAt ?? createdAt)` older than `settings.approvalReminderHours`; appends new deliveries to `sentTo`, increments `reminderCount`, sets `remindedAt`.
  - `GET /api/cron/approval-reminders` guarded by `CRON_SECRET` exactly like `expire-holds`.

- [ ] **Step 1: Write the failing test**

Create `src/test/approval-admin-reminders.test.ts` (desk-mode header + fetch stub as in Task 8, PLUS `process.env.CRON_SECRET = "cron-secret-for-tests"` in the top-of-file env block since env freezes at first import; seed THREE pending bookings with distinct idempotency keys + `createApprovalRequest` for each, manager Naomi linked chatId "777"):

```ts
describe("admin confirm + reminders", () => {
  it("admin confirm flips the booking, closes the request, edits the pings", async () => {
    const { confirmBookingAdmin } = await import("@/lib/admin/confirm-booking");
    const res = await confirmBookingAdmin(bookingId, "Desk admin");
    expect(res.status).toBe("confirmed");
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.bookingId, bookingId));
    expect(row!.status).toBe("confirmed");
    expect(row!.decidedChannel).toBe("admin");
    expect(telegramCalls.some((c) => c.method === "editMessageText")).toBe(true);
  });

  it("reminder pings once, then respects the max", async () => {
    // Second booking + request; backdate createdAt beyond approvalReminderHours.
    const { runApprovalReminders } = await import("@/lib/approval/reminders");
    await db.update(approvalRequests).set({ createdAt: new Date(Date.now() - 5 * 3600_000) }).where(eq(approvalRequests.id, secondRequestId));
    const first = await runApprovalReminders();
    expect(first.reminded).toBe(1);
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, secondRequestId));
    expect(row!.reminderCount).toBe(1);
    const again = await runApprovalReminders();
    expect(again.reminded).toBe(0); // maxReminders default 1
  });

  it("janitor closes requests whose booking got decided elsewhere", async () => {
    // Third booking + request; cancel the booking directly, then run.
    await db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, thirdBookingId));
    const { runApprovalReminders } = await import("@/lib/approval/reminders");
    const res = await runApprovalReminders();
    expect(res.closed).toBe(1);
  });

  it("cron route requires the secret", async () => {
    const { GET } = await import("@/app/api/cron/approval-reminders/route");
    const no = await GET(new Request("http://localhost:3000/api/cron/approval-reminders"));
    expect(no.status).toBe(401);
    const ok = await GET(new Request("http://localhost:3000/api/cron/approval-reminders", { headers: { authorization: "Bearer cron-secret-for-tests" } }));
    expect(ok.status).toBe(200);
  });
});
```

(Write the full beforeAll seeds: three bookings with distinct idempotency keys, requests for all three via `createApprovalRequest`. Declare `db`, `telegramCalls`, ids as module-level `let` set in beforeAll.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/approval-admin-reminders.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/lib/admin/confirm-booking.ts`**

```ts
/**
 * Admin-side confirm for pending bookings. Online mode never needed this (the
 * Stripe webhook confirmed), desk mode does. When an open approval request
 * exists we route through the SAME decision funnel as a chat tap, so the
 * request closes, the audit trail records the admin, and every Telegram ping
 * updates to "Confirmed by X". Without a request it is a plain guarded flip.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { approvalRequests, bookings } from "@/lib/db/schema";
import { applyDecision } from "@/lib/approval/core";
import { broadcastDecision } from "@/lib/approval/broadcast";
import { notifyBookingConfirmed } from "@/lib/email/notifications";
import { Errors } from "@/lib/http/errors";

export async function confirmBookingAdmin(id: string, adminName: string): Promise<{ id: string; status: string }> {
  const db = await getDb();
  const [open] = await db.select().from(approvalRequests)
    .where(and(eq(approvalRequests.bookingId, id), eq(approvalRequests.status, "open")));

  if (open) {
    const result = await applyDecision(open.id, "confirm", { name: adminName, channel: "admin" });
    if (result.outcome === "confirmed") {
      await broadcastDecision(open.id);
      return { id, status: "confirmed" };
    }
    if (result.outcome === "already_handled") throw Errors.conflict("This booking was already handled");
    throw Errors.conflict("This booking can no longer be confirmed");
  }

  const flipped = await db.update(bookings)
    .set({ status: "confirmed", updatedAt: new Date() })
    .where(and(eq(bookings.id, id), eq(bookings.status, "pending")))
    .returning({ id: bookings.id });
  if (flipped.length === 0) throw Errors.conflict("Only a pending booking can be confirmed");
  await notifyBookingConfirmed(id).catch(() => undefined);
  return { id, status: "confirmed" };
}
```

- [ ] **Step 4: Implement `src/app/api/admin/bookings/[id]/confirm/route.ts`**

Mirror `move/route.ts` exactly:

```ts
import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { confirmBookingAdmin } from "@/lib/admin/confirm-booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const POST = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const result = await mutate(req, "admin.booking_confirmed", async (ctx) => {
    const row = await confirmBookingAdmin(id, ctx.admin.email ?? "Admin");
    return { result: row, entity: "booking", entityId: id, after: { status: row.status } };
  }, { roles: ["owner", "staff"] });
  return json(result, req);
});
```

(Check the `mutate` callback context shape in `src/lib/admin/guard.ts` for the admin's display field: use `ctx.admin.email` or the name field that exists.)

- [ ] **Step 5: Implement `src/lib/approval/reminders.ts`**

```ts
/**
 * Cron chores for the approval loop. Janitor first: any OPEN request whose
 * booking is no longer pending is closed (decided in the admin, cancelled,
 * or picked up). Then reminders: re-ping Telegram for open requests still
 * pending, unexpired, under the reminder cap, and quiet for at least
 * approvalReminderHours. Never customer-facing; an unanswered booking just
 * stays pending in the admin.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { approvalRequests, bookings, type ApprovalDelivery } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";
import { buildApprovalMessage } from "@/lib/approval/message";
import { telegramConfigured, sendApprovalMessage } from "@/lib/approval/telegram";
import { notifyAdmin } from "@/lib/notify";
import { logger } from "@/lib/logger";

export async function runApprovalReminders(now = new Date()): Promise<{ reminded: number; closed: number }> {
  const db = await getDb();
  const settings = await getSettings();

  // Janitor: open requests whose booking left "pending".
  const stale = await db.select({ id: approvalRequests.id, bookingId: approvalRequests.bookingId })
    .from(approvalRequests)
    .innerJoin(bookings, eq(approvalRequests.bookingId, bookings.id))
    .where(and(eq(approvalRequests.status, "open"), ne(bookings.status, "pending")));
  if (stale.length) {
    await db.update(approvalRequests)
      .set({ status: "closed", updatedAt: now })
      .where(inArray(approvalRequests.id, stale.map((s) => s.id)));
  }

  // Reminders.
  const open = await db.select({ request: approvalRequests })
    .from(approvalRequests)
    .innerJoin(bookings, eq(approvalRequests.bookingId, bookings.id))
    .where(and(eq(approvalRequests.status, "open"), eq(bookings.status, "pending")));

  const threshold = settings.approvalReminderHours * 3600_000;
  let reminded = 0;
  for (const { request } of open) {
    if (request.reminderCount >= settings.approvalMaxReminders) continue;
    if (request.expiresAt.getTime() < now.getTime()) continue;
    const last = request.remindedAt ?? request.createdAt;
    if (now.getTime() - last.getTime() < threshold) continue;

    const msg = await buildApprovalMessage(request.bookingId);
    if (!msg) continue;
    const deliveries: ApprovalDelivery[] = [...request.sentTo];
    if (telegramConfigured()) {
      for (const m of settings.approvalManagers.filter((m) => m.chatId)) {
        try {
          const messageId = await sendApprovalMessage(m.chatId!, `Reminder: ${msg.text}`, request.id);
          deliveries.push({ channel: "telegram", to: m.chatId!, messageId: messageId ?? undefined, sentAt: now.toISOString() });
        } catch (e) {
          logger.error("approval_reminder_send_failed", { requestId: request.id, error: (e as Error).message });
        }
      }
    }
    await db.update(approvalRequests)
      .set({ reminderCount: request.reminderCount + 1, remindedAt: now, sentTo: deliveries, updatedAt: now })
      .where(eq(approvalRequests.id, request.id));
    await notifyAdmin({
      level: "warning", type: "approval.reminder", title: "Booking still waiting for approval",
      body: msg.fleetLine, bookingId: request.bookingId,
    });
    reminded += 1;
  }
  return { reminded, closed: stale.length };
}
```

- [ ] **Step 6: Implement `src/app/api/cron/approval-reminders/route.ts`**

Copy the `expire-holds` route shape exactly:

```ts
import { NextResponse } from "next/server";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { runApprovalReminders } from "@/lib/approval/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/cron/approval-reminders — hourly nudge for unanswered desk-mode
 *  approvals plus a janitor for requests decided elsewhere. CRON_SECRET
 *  guarded like every cron. */
export async function GET(req: Request): Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  if (!env.CRON_SECRET || auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runApprovalReminders();
  logger.info("cron_approval_reminders", result);
  return NextResponse.json({ ok: true, ...result });
}
```

`vercel.json`: add to `crons`:

```json
    {
      "path": "/api/cron/approval-reminders",
      "schedule": "0 * * * *"
    }
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/test/approval-admin-reminders.test.ts` → PASS.
Run: `npm test && npm run typecheck` → green.

- [ ] **Step 8: Commit**

```bash
git add src/lib/admin/confirm-booking.ts "src/app/api/admin/bookings/[id]/confirm" src/lib/approval/reminders.ts src/app/api/cron/approval-reminders vercel.json src/test/approval-admin-reminders.test.ts
git commit -m "feat(approval): admin confirm action + hourly reminder cron with janitor"
```

---

### Task 11: Frontend (wizard, confirmation, admin drawer, settings managers UI)

**Files:**
- Modify: `src/app/(public)/book/page.tsx` (desk-mode branch)
- Modify: `src/app/(public)/book/confirmation/page.tsx` (desk-mode copy)
- Modify: `src/app/admin/(shell)/booking-drawer.tsx` (Confirm button for pending)
- Modify: `src/app/admin/(shell)/settings/page.tsx` (managers card)
- Modify: admin settings API route if it filters fields (check `src/app/api/admin/settings/route.ts` accepts the new patch keys via `SettingsPatchSchema`; it should already)
- Test: `src/test/desk-mode-ui-config.test.ts` (new, API-level assertions; UI is verified by typecheck + build + existing patterns)

**Steps (this task is UI-heavy; read each file fully before editing, keep every existing class name and pattern):**

- [ ] **Step 1: Wizard `src/app/(public)/book/page.tsx`**

The wizard already fetches `/api/booking-config`. Thread `paymentMode` from that response into state. Then:
- Where the note at ~line 649 says `You'll be taken to our secure Stripe checkout.`, render instead when `paymentMode === "desk"`: `No payment needed now. You pay at pickup at the desk.`
- In the submit handler (~line 252): when desk, after the `/api/bookings` POST succeeds, skip the `/api/bookings/${id}/checkout` fetch entirely: `clearWizardStorage(); window.location.href = \`/book/confirmation?id=${data.id}\`; return;`
- The canceled-checkout resume path (~line 123) only runs in online mode: guard it with `paymentMode !== "desk"`.
- If the wizard shows a "pay now" amount derived from `paymentOption`, label it `Due at pickup` in desk mode with the full total. Send `paymentOption: "full"` in desk mode.

- [ ] **Step 2: Confirmation `src/app/(public)/book/confirmation/page.tsx`**

Fetch `/api/booking-config` alongside the booking poll. In desk mode:
- pending state: heading `Booking received`, body `Your booking for {dates} is in. Our team will confirm it shortly and you pay at pickup. A confirmation email is on its way once it is approved.` Drop the `If you just paid...` sentence and the "Check again" payment framing.
- confirmed state: heading `Booking confirmed`, body without the words `Payment received` (desk mode took no payment): `Your booking for {dates} is confirmed. See you at pickup; you pay at the desk.`
- Online mode rendering stays byte-for-byte identical.

- [ ] **Step 3: Admin drawer `src/app/admin/(shell)/booking-drawer.tsx`**

Find where status-dependent actions render (the cancel button). For `status === "pending"` add a primary `Confirm booking` button that POSTs to `/api/admin/bookings/${id}/confirm` (follow the drawer's existing fetch + refresh pattern for cancel), with its error toast/message on 409.

- [ ] **Step 4: Settings managers card `src/app/admin/(shell)/settings/page.tsx`**

Add a `Booking approvals` card following the page's existing card/save patterns:
- Rows for `approvalManagers`: inputs for name, email (optional), and a read-only Telegram status: `Linked` when `chatId` set, otherwise an invite link `https://t.me/<botUsername>?start=<inviteCode>` with a Copy button. Generate `inviteCode` client-side on add: `crypto.randomUUID()` (matches the `[A-Za-z0-9_-]{8,64}` rule). Remove button per row.
- Number inputs for `approvalReminderHours` (1-168) and `approvalMaxReminders` (0-10).
- Save through the page's existing settings PATCH flow (the schema from Task 3 already accepts the fields).
- Bot username: extend the admin settings GET response (`src/app/api/admin/settings/route.ts`) with `telegramBotUsername: env.TELEGRAM_BOT_USERNAME` and `telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN)`; when not configured, show the invite column as `Set TELEGRAM_BOT_TOKEN to enable Telegram pings. Email still works.`

- [ ] **Step 5: API-level test `src/test/desk-mode-ui-config.test.ts`**

```ts
process.env.PAYMENT_MODE = "desk";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

import { describe, it, expect, beforeAll } from "vitest";

beforeAll(async () => {
  const { runMigrations } = await import("@/lib/db/migrate");
  await runMigrations();
});

describe("desk mode surfaces", () => {
  it("booking-config tells the wizard it is desk mode", async () => {
    const { GET } = await import("@/app/api/booking-config/route");
    const res = await GET(new Request("http://localhost:3000/api/booking-config", { headers: { "user-agent": "t" } }), { params: Promise.resolve({}) });
    expect((await res.json()).paymentMode).toBe("desk");
  });
});
```

- [ ] **Step 6: Verify**

Run: `npm test` → green. `npm run typecheck` → clean. `npm run build` → clean (this compiles both pages and the drawer; JSX errors surface here).

- [ ] **Step 7: Commit**

```bash
git add "src/app/(public)/book" "src/app/admin/(shell)" src/app/api/admin/settings src/test/desk-mode-ui-config.test.ts
git commit -m "feat(desk-mode): wizard + confirmation copy, admin confirm button, managers settings UI"
```

---

### Task 12: Runbook, env example, full verification

**Files:**
- Modify: `LAUNCH.md` (new section)
- Modify: `.env.example` (if the repo has one; check `ls -a`; otherwise the env docs live in LAUNCH.md)
- Test: full suite + typecheck + build

- [ ] **Step 1: Add the runbook section to `LAUNCH.md`**

Append a `## Desk mode + Telegram approvals (per client)` section covering, in order:
1. Set `PAYMENT_MODE=desk` on the deployment (Stripe vars can be removed).
2. Create the bot: BotFather, `/newbot`, pick name `<Client> Bookings`, copy the token. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, and generate `TELEGRAM_WEBHOOK_SECRET` (`openssl rand -hex 24`).
3. Deploy, then run `npm run telegram:setup` (points the webhook at `APP_ORIGIN/api/webhooks/telegram`).
4. In the admin: Settings, Booking approvals, add each manager, send them their invite link, watch the status flip to Linked.
5. Manual E2E checklist: place a test booking on the site; both managers receive the ping with the fleet line; tap Confirm on one phone; the other phone's message updates to Confirmed by X; the booking is confirmed in the admin; the customer confirmation email arrived; a second tap answers already handled; the email fallback buttons open the review page and report already handled.
6. Notes: bookings never auto-cancel in desk mode; unanswered requests get one reminder after 4 hours (both knobs in settings); the admin Confirm button works with or without Telegram.

- [ ] **Step 2: Env documentation**

If `.env.example` exists, add `PAYMENT_MODE`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` with one-line comments matching env.ts. If not, ensure LAUNCH.md lists them.

- [ ] **Step 3: Full verification**

Run: `npm test` → all green, count noted.
Run: `npm run typecheck` → clean.
Run: `npm run build` → clean production build.

- [ ] **Step 4: Commit**

```bash
git add LAUNCH.md .env.example
git commit -m "docs: desk mode + telegram approval rollout runbook"
```

---

## Self-Review (done at planning time)

- **Spec coverage:** desk mode (Tasks 1, 2, 11), approval core + table (3, 4, 5, 7), Telegram adapter + linking + no-router webhook (6, 8), email fallback + scanner-safe page (7, 9), admin confirm + janitor + reminders (10), settings UI + invite links (11), runbook (12). Reminder "same channels": implemented as Telegram + admin bell by design (email is not re-sent; the original email stays valid, and re-mailing reads as spam).
- **Type consistency:** `ApprovalManager`/`ApprovalDelivery` defined once in schema files (Task 3) and imported everywhere; `DecisionOutcome` defined in core (Task 7) and consumed by Tasks 8-10; `parseTelegramUpdate` shapes defined in Task 6 and consumed in Task 8.
- **Known judgment calls for implementers:** seed literals for vehicles/bookings/licenses must be copied from existing tests (`move-booking.test.ts` etc.) rather than invented; `mutate` ctx admin field name must be checked in `guard.ts`; `shell`/`money` helper signatures must be checked in `templates.ts`.
