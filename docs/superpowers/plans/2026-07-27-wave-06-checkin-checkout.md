# Check-in / Check-out (Storage + Inspections) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff-guided check-in and check-out wizards (licence photo, walk-around photos, odometer/fuel, borg, rules + signature, contract PDF) on top of a new env-driven object-storage layer, flipping bookings `confirmed → picked_up → completed` with full checklist surfacing in the BookingDrawer.

**Architecture:** A storage facade (`src/lib/storage`, local-disk driver for dev/test + Supabase Storage driver for prod) feeds a multipart admin upload route and a same-origin file-streaming route (the strict CSP forbids cross-origin images, so the admin UI always loads media through `/api/admin/files/...`). A new `inspections` table (one row per booking per kind `pickup|return`) holds photos, checklist booleans, and borg fields; `completePickup`/`completeReturn` guard the status transitions, render the contract PDF with `@react-pdf/renderer`, and fan out bell + email notifications. Two mobile-first admin wizard pages drive the flow; a self-contained `InspectionPanel` drops into the BookingDrawer.

**Tech Stack:** Next.js 15 (app router, node runtime), Drizzle ORM (PGlite dev/test, Supabase Postgres prod), zod at every boundary, `@react-pdf/renderer` (new), `@supabase/supabase-js` (new), vitest.

## Preconditions (plans 01, 02 are merged before this plan runs)

- `bookings` columns are `startAt`/`endAt`/`bufferEndAt` (timestamptz, drizzle returns `Date` objects) and `amountPaidCents` (int, default 0). Status enum already contains `'picked_up'` (added by plan 01's constraint migration; THIS plan writes it for the first time).
- `payments` has `method` pgEnum `payment_method` (`'stripe'|'desk'`) and `type` includes `'extension'` (plan 02).
- `paymentOption` enum values are `('deposit','full')` (plan 02).
- `src/lib/time/format.ts` exports `formatDateTime(iso: string): string` (plan 01).
- `src/lib/site-config.ts` exports `siteName` (plan 02).
- `src/app/admin/(shell)/booking-drawer.tsx` exists (plan 02) and is the primary booking surface.
- Timestamp columns (`bookings.startAt/endAt/bufferEndAt`, `availabilityBlocks.startAt/endAt`) use drizzle `mode: "string"` (plan 01 decision): INSERT ISO strings (`atAruba("2026-08-01","09:00")` or `new Date(x).toISOString()`), and parse reads with `parseTs` from `@/lib/time/format` before any numeric math. Wherever a step below writes `startAt: new Date(...)` in fixtures or inserts, convert to an ISO string; the code compiles against whatever the actual schema says, so check `src/lib/db/schema/bookings.ts` first.
- Work happens on branch `feat/wave-2026-07`.

## Global Constraints

- Tests: `npm test -- --no-file-parallelism` (vitest). New features land with tests.
- NEVER `npm run build` while a `next dev` server is running (shared `.next` corrupts).
- Migrations: `npm run db:generate` for drizzle diffs; hand-written SQL files in `./drizzle` for constraints/enum surgery (precedent: 0002, 0007, 0010). Applied with `npm run db:migrate`. Must work on BOTH PGlite (`pglite://`, dev/test) and Postgres (Supabase prod).
- Admin mutations go through `mutate(req, action, fn)` from `src/lib/admin/guard.ts` (audit-logged); reads through `read(req, fn)`.
- Admin UI: reuse `Modal, Drawer, useToast, useConfirm, Skeleton, EmptyState, registerPaletteAction` from `@/app/admin/_ui` and `DatePicker, Select` from `@/components/ui`. Strict CSP: no external assets ever. Money is integer cents.
- Copy: dash-free house style (no em-dashes), warm/human tone.
- Timezone: operator-local day logic uses `America/Aruba` (existing `arubaToday()` precedent).
- Design principle: less clicking. One click from a planning bar opens the BookingDrawer with everything in it.
- Workstream-specific (spec W4): the wizard runs on a STAFF device behind admin auth, mobile-first with big tap targets; the borg (security deposit) is never charged online, only recorded; checklist items are single-tap toggles, each toggle audit-logged; the exclusion constraint already covers `picked_up` so a car that is out can never be double-booked.
- Storage keys follow the seams doc verbatim: `inspections/{bookingId}/{kind}/{uuid}.jpg`, `licenses/{bookingId}/{uuid}.jpg`, `contracts/{bookingId}.pdf`, `signatures/{bookingId}.png`.
- The ONLY new dependencies allowed: `@react-pdf/renderer`, `@supabase/supabase-js`.

---

### Task 1: Storage foundation: deps, env, key safety, local driver

**Files:**
- Modify: `package.json` (via `npm install`)
- Modify: `src/env.ts` (add STORAGE_* vars; insertion points quoted below)
- Modify: `.gitignore` (add `.dev-storage`)
- Create: `src/lib/storage/shared.ts`
- Create: `src/lib/storage/local.ts`
- Create: `src/lib/storage/index.ts`
- Test: `src/test/storage-local.test.ts`

**Interfaces:**
- Consumes: `env` from `@/env` (zod-validated env singleton), `Errors` from `@/lib/http/errors` (typed AppError constructors: `Errors.badRequest(msg)` etc.).
- Produces (the storage seam every later task uses):
  - `putObject(key: string, data: Uint8Array, contentType: string): Promise<void>`
  - `getObject(key: string): Promise<{ data: Uint8Array; contentType: string }>` (plan-local addition so the admin UI can stream media same-origin under the strict CSP)
  - `getSignedUrl(key: string, ttlSeconds: number): Promise<string>`
  - `deleteObject(key: string): Promise<void>`
  - `assertSafeKey(key: string): void`, `contentTypeForKey(key: string): string`
  - `signLocalUrl(key: string, expEpochSeconds: number): string` and `verifyLocalSignature(key, exp, sig): boolean` from `@/lib/storage/local` (used by Task 2's dev route)
  - New env keys: `STORAGE_DRIVER` (`'supabase'|'local'`, default `'local'`), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `STORAGE_BUCKET` (default `'fleet-docs'`), `LOCAL_STORAGE_DIR` (default `'.dev-storage'`)

**Steps:**

- [ ] Install the two allowed new dependencies:

```bash
npm install @react-pdf/renderer@^4 @supabase/supabase-js@^2
```

Expect both to appear under `dependencies` in `package.json`. (`@react-pdf/renderer` v4 supports React 19; do not pick v3.)

- [ ] Add the storage env vars to `src/env.ts`. Find this existing block near the end of the `EnvSchema` object (it is the last group of fields; if a previous wave plan appended more fields after it, add after those instead):

```ts
    WHATSAPP_TOKEN: z.string().optional().default(""),
    WHATSAPP_PHONE_ID: z.string().optional().default(""),
    WHATSAPP_OWNER_TO: z.string().optional().default(""),
```

and insert directly after it, still inside the `z.object({...})`:

```ts
    // Object storage for inspection photos, licence copies, signatures, and
    // contract PDFs. 'local' writes under LOCAL_STORAGE_DIR (dev/test);
    // 'supabase' uses a PRIVATE Supabase Storage bucket via the service-role
    // key (prod). Media is always PRIVATE; the app streams it to admins only.
    STORAGE_DRIVER: z.enum(["supabase", "local"]).default("local"),
    SUPABASE_URL: z.string().url().optional().or(z.literal("")).default(""),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(""),
    STORAGE_BUCKET: z.string().optional().default("fleet-docs"),
    LOCAL_STORAGE_DIR: z.string().optional().default(".dev-storage"),
```

- [ ] Still in `src/env.ts`, make the schema fail closed when the supabase driver is selected without credentials. The object currently closes with:

```ts
  });

export type Env = z.infer<typeof EnvSchema>;
```

Change it to (if an earlier wave plan already chained a `.superRefine`, add this check inside that existing callback instead of chaining a second one):

```ts
  })
  .superRefine((v, ctx) => {
    if (v.STORAGE_DRIVER === "supabase" && (!v.SUPABASE_URL || !v.SUPABASE_SERVICE_ROLE_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["STORAGE_DRIVER"],
        message: "STORAGE_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;
```

- [ ] Keep the local store out of git:

```bash
grep -qx '.dev-storage' .gitignore || printf '\n# local object-storage driver (STORAGE_DRIVER=local)\n.dev-storage\n' >> .gitignore
```

- [ ] Write the failing test `src/test/storage-local.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { putObject, getObject, deleteObject, getSignedUrl, assertSafeKey, contentTypeForKey } from "@/lib/storage";
import { signLocalUrl, verifyLocalSignature } from "@/lib/storage/local";

afterAll(async () => {
  await rm(path.resolve(process.cwd(), ".dev-storage"), { recursive: true, force: true });
});

describe("local storage driver", () => {
  it("round-trips putObject -> getObject with the right content type", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await putObject("inspections/test-booking/pickup/a.jpg", bytes, "image/jpeg");
    const got = await getObject("inspections/test-booking/pickup/a.jpg");
    expect(Array.from(got.data)).toEqual([1, 2, 3, 4]);
    expect(got.contentType).toBe("image/jpeg");
  });

  it("deleteObject removes the file and a re-read rejects", async () => {
    await putObject("contracts/gone.pdf", new Uint8Array([9]), "application/pdf");
    await deleteObject("contracts/gone.pdf");
    await expect(getObject("contracts/gone.pdf")).rejects.toThrow();
  });

  it("rejects traversal and malformed keys before any filesystem access", () => {
    expect(() => assertSafeKey("../etc/passwd")).toThrow();
    expect(() => assertSafeKey("a/../b.jpg")).toThrow();
    expect(() => assertSafeKey("/absolute.jpg")).toThrow();
    expect(() => assertSafeKey("a//b.jpg")).toThrow();
    expect(() => assertSafeKey("ok folder/x.jpg")).toThrow(); // no spaces
    expect(() => assertSafeKey("inspections/b1/pickup/x.jpg")).not.toThrow();
  });

  it("maps content types from extensions", () => {
    expect(contentTypeForKey("a/b.jpg")).toBe("image/jpeg");
    expect(contentTypeForKey("a/b.png")).toBe("image/png");
    expect(contentTypeForKey("a/b.webp")).toBe("image/webp");
    expect(contentTypeForKey("a/b.pdf")).toBe("application/pdf");
    expect(contentTypeForKey("a/b.bin")).toBe("application/octet-stream");
  });

  it("signed local URLs verify, bind to the key, and expire", () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const sig = signLocalUrl("k.jpg", exp);
    expect(verifyLocalSignature("k.jpg", exp, sig)).toBe(true);
    expect(verifyLocalSignature("other.jpg", exp, sig)).toBe(false);
    const past = Math.floor(Date.now() / 1000) - 120;
    expect(verifyLocalSignature("k.jpg", past, signLocalUrl("k.jpg", past))).toBe(false);
  });

  it("getSignedUrl points at the dev route with exp and sig params", async () => {
    const url = await getSignedUrl("contracts/x.pdf", 60);
    const u = new URL(url);
    expect(u.pathname).toBe("/api/dev/storage/contracts/x.pdf");
    expect(Number(u.searchParams.get("exp"))).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(u.searchParams.get("sig")).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] Run it to verify it fails:

```bash
npm test -- --no-file-parallelism src/test/storage-local.test.ts
```

Expected failure: `Failed to resolve import "@/lib/storage"` (the module does not exist yet).

- [ ] Create `src/lib/storage/shared.ts`:

```ts
import { Errors } from "@/lib/http/errors";

/** A stored-object driver. Implemented by ./local (dev/test) and ./supabase (prod). */
export interface StorageDriver {
  putObject(key: string, data: Uint8Array, contentType: string): Promise<void>;
  getObject(key: string): Promise<{ data: Uint8Array; contentType: string }>;
  getSignedUrl(key: string, ttlSeconds: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

const SAFE_KEY = /^[a-z0-9][a-z0-9/_.-]*$/i;

/**
 * Reject traversal, absolute, and malformed keys BEFORE they reach any
 * filesystem path or storage API. Every facade function calls this, so no
 * driver can ever see a hostile key (defense-in-depth against path traversal).
 */
export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes("..") || key.includes("//") || key.length > 300) {
    throw Errors.badRequest("Invalid storage key");
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** Content type from the key's extension (the local driver stores no metadata). */
export function contentTypeForKey(key: string): string {
  const dot = key.lastIndexOf(".");
  return (dot >= 0 ? CONTENT_TYPES[key.slice(dot).toLowerCase()] : undefined) ?? "application/octet-stream";
}
```

- [ ] Create `src/lib/storage/local.ts`:

```ts
/**
 * Local-disk storage driver (dev/test). Files live under LOCAL_STORAGE_DIR
 * (default .dev-storage/). "Signed URLs" are HMAC-signed links to the dev-only
 * route /api/dev/storage/[...key], mirroring how the Supabase driver returns
 * short-lived signed URLs in production. The HMAC key is SESSION_SECRET, which
 * is already required to be strong at boot.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/env";
import { contentTypeForKey, type StorageDriver } from "./shared";

function baseDir(): string {
  return path.resolve(process.cwd(), env.LOCAL_STORAGE_DIR);
}

/** Resolve a key inside the storage dir; belt-and-braces escape check. */
function filePath(key: string): string {
  const fp = path.resolve(baseDir(), key);
  if (!fp.startsWith(baseDir() + path.sep)) throw new Error("Storage key escapes the storage directory");
  return fp;
}

export function signLocalUrl(key: string, expEpochSeconds: number): string {
  return createHmac("sha256", env.SESSION_SECRET).update(`${key}:${expEpochSeconds}`).digest("hex");
}

export function verifyLocalSignature(key: string, expEpochSeconds: number, sig: string): boolean {
  if (!Number.isInteger(expEpochSeconds) || expEpochSeconds * 1000 < Date.now()) return false;
  const expected = Buffer.from(signLocalUrl(key, expEpochSeconds));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function localDriver(): StorageDriver {
  return {
    async putObject(key, data) {
      const fp = filePath(key);
      await mkdir(path.dirname(fp), { recursive: true });
      await writeFile(fp, data);
    },
    async getObject(key) {
      const data = await readFile(filePath(key));
      return { data: new Uint8Array(data), contentType: contentTypeForKey(key) };
    },
    async getSignedUrl(key, ttlSeconds) {
      const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
      return `${env.APP_ORIGIN}/api/dev/storage/${key}?exp=${exp}&sig=${signLocalUrl(key, exp)}`;
    },
    async deleteObject(key) {
      await rm(filePath(key), { force: true });
    },
  };
}
```

- [ ] Create `src/lib/storage/index.ts`:

```ts
/**
 * Object storage facade (spec W4, shared infra). One import site for the app:
 *   import { putObject, getObject, getSignedUrl, deleteObject } from "@/lib/storage";
 * Driver chosen by env.STORAGE_DRIVER: 'local' (dev/test) or 'supabase' (prod,
 * private bucket + service-role key). Keys are validated against traversal on
 * every call, whichever driver is active. Media is PRIVATE by construction:
 * nothing here ever produces a public URL.
 */
import { env } from "@/env";
import { assertSafeKey, type StorageDriver } from "./shared";

export { assertSafeKey, contentTypeForKey, type StorageDriver } from "./shared";

let driverPromise: Promise<StorageDriver> | null = null;

function getDriver(): Promise<StorageDriver> {
  driverPromise ??= env.STORAGE_DRIVER === "supabase"
    ? import("./supabase").then((m) => m.supabaseDriver())
    : import("./local").then((m) => m.localDriver());
  return driverPromise;
}

export async function putObject(key: string, data: Uint8Array, contentType: string): Promise<void> {
  assertSafeKey(key);
  return (await getDriver()).putObject(key, data, contentType);
}

export async function getObject(key: string): Promise<{ data: Uint8Array; contentType: string }> {
  assertSafeKey(key);
  return (await getDriver()).getObject(key);
}

export async function getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
  assertSafeKey(key);
  return (await getDriver()).getSignedUrl(key, ttlSeconds);
}

export async function deleteObject(key: string): Promise<void> {
  assertSafeKey(key);
  return (await getDriver()).deleteObject(key);
}
```

Note: `src/lib/storage/supabase.ts` does not exist yet (Task 2). The dynamic `import("./supabase")` only runs when `STORAGE_DRIVER=supabase`, which never happens in tests, but TypeScript still needs the module to typecheck the import. Create a placeholder is NOT allowed; instead Task 2 follows immediately. For THIS task's typecheck to pass, temporarily the import must resolve, so create the real (small) supabase driver now if `npx tsc --noEmit` complains, or simply proceed to run only the test file (vitest transpiles per-file and will not touch the supabase import). Run the test first; if the later full typecheck step fails on the missing module, do Task 2's `supabase.ts` file as part of this commit and say so in the commit body.

- [ ] Run the test to verify it passes:

```bash
npm test -- --no-file-parallelism src/test/storage-local.test.ts
```

Expected: 6 tests pass.

- [ ] Commit:

```bash
git add package.json package-lock.json src/env.ts .gitignore src/lib/storage src/test/storage-local.test.ts
git commit -m "feat(storage): env-driven object storage facade with local driver and signed dev URLs"
```

---

### Task 2: Supabase driver, dev signed route, admin file streaming route

**Files:**
- Create: `src/lib/storage/supabase.ts`
- Create: `src/app/api/dev/storage/[...key]/route.ts`
- Create: `src/app/api/admin/files/[...key]/route.ts`
- Test: (covered by Task 1's signature tests; the Supabase driver is a thin SDK adapter exercised in prod, and the routes are wrappers over `read()` + `getObject`)

**Interfaces:**
- Consumes: `env` from `@/env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `STORAGE_BUCKET`, `STORAGE_DRIVER`); `contentTypeForKey`, `getObject` from `@/lib/storage`; `verifyLocalSignature` from `@/lib/storage/local`; `withRoute` from `@/lib/http/handler` (route wrapper: `withRoute<P>(async (req, { params, requestId }) => NextResponse)`); `read` from `@/lib/admin/guard` (`read(req, fn)` runs `requireAdmin` then `fn`, returns `fn`'s result); `Errors` from `@/lib/http/errors`.
- Produces:
  - `supabaseDriver(): StorageDriver` in `src/lib/storage/supabase.ts`
  - `GET /api/dev/storage/[...key]?exp=&sig=` streams a local-driver object when the HMAC signature is valid (404 unless `STORAGE_DRIVER=local`)
  - `GET /api/admin/files/[...key]` streams any stored object same-origin to an authenticated admin. **Every piece of admin UI in later tasks loads media as `/api/admin/files/{key}`** (the strict CSP `img-src 'self'` forbids loading Supabase URLs directly).

**Steps:**

- [ ] Create `src/lib/storage/supabase.ts`:

```ts
/**
 * Supabase Storage driver (production). Talks to a PRIVATE bucket
 * (STORAGE_BUCKET, default fleet-docs) with the SERVICE-ROLE key, exactly what
 * the driver_licenses.documentRef comment anticipated: private object storage,
 * opened only via short-lived signed URLs or same-origin admin streaming.
 * One-time prod setup (documented here, not automated): create the bucket in
 * the Supabase dashboard with "Public bucket" OFF.
 */
import { createClient } from "@supabase/supabase-js";
import { env } from "@/env";
import { contentTypeForKey, type StorageDriver } from "./shared";

export function supabaseDriver(): StorageDriver {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("STORAGE_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const bucket = () => client.storage.from(env.STORAGE_BUCKET);

  return {
    async putObject(key, data, contentType) {
      const { error } = await bucket().upload(key, data, { contentType, upsert: true });
      if (error) throw new Error(`storage upload failed for ${key}: ${error.message}`);
    },
    async getObject(key) {
      const { data, error } = await bucket().download(key);
      if (error || !data) throw new Error(`storage download failed for ${key}: ${error?.message ?? "no data"}`);
      return { data: new Uint8Array(await data.arrayBuffer()), contentType: data.type || contentTypeForKey(key) };
    },
    async getSignedUrl(key, ttlSeconds) {
      const { data, error } = await bucket().createSignedUrl(key, ttlSeconds);
      if (error || !data?.signedUrl) throw new Error(`storage sign failed for ${key}: ${error?.message ?? "no url"}`);
      return data.signedUrl;
    },
    async deleteObject(key) {
      const { error } = await bucket().remove([key]);
      if (error) throw new Error(`storage delete failed for ${key}: ${error.message}`);
    },
  };
}
```

- [ ] Create `src/app/api/dev/storage/[...key]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/http/handler";
import { Errors } from "@/lib/http/errors";
import { env } from "@/env";
import { getObject } from "@/lib/storage";
import { verifyLocalSignature } from "@/lib/storage/local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/dev/storage/[...key]?exp=<epoch-seconds>&sig=<hmac-hex>
 * Serves LOCAL-driver objects behind an HMAC-signed, expiring link — the dev
 * stand-in for Supabase signed URLs. Hard-404s unless STORAGE_DRIVER=local, so
 * it does not exist in a Supabase-backed deployment.
 */
export const GET = withRoute<{ key: string[] }>(async (req, { params }) => {
  if (env.STORAGE_DRIVER !== "local") throw Errors.notFound();
  const key = (params.key ?? []).join("/");
  const url = new URL(req.url);
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  if (!verifyLocalSignature(key, exp, sig)) throw Errors.forbidden("This link is invalid or has expired");
  const { data, contentType } = await getObject(key).catch(() => {
    throw Errors.notFound("File not found");
  });
  return new NextResponse(Buffer.from(data), {
    headers: { "Content-Type": contentType, "Cache-Control": "private, no-store" },
  });
});
```

- [ ] Create `src/app/api/admin/files/[...key]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/http/handler";
import { read } from "@/lib/admin/guard";
import { Errors } from "@/lib/http/errors";
import { getObject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/files/[...key] — stream a stored object to an authenticated
 * admin, SAME-ORIGIN. The admin UI's strict CSP (img-src 'self') forbids
 * loading cross-origin Supabase URLs, so all inspection photos, signatures,
 * and contracts render through this route regardless of the active driver.
 * PDFs download with a filename; images render inline.
 */
export const GET = withRoute<{ key: string[] }>(async (req, { params }) =>
  read(req, async () => {
    const key = (params.key ?? []).join("/");
    const { data, contentType } = await getObject(key).catch(() => {
      throw Errors.notFound("File not found");
    });
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=60",
    };
    if (key.endsWith(".pdf")) {
      headers["Content-Disposition"] = `attachment; filename="${key.split("/").pop() ?? "document.pdf"}"`;
    }
    return new NextResponse(Buffer.from(data), { headers });
  }),
);
```

- [ ] Typecheck and lint:

```bash
npx tsc --noEmit && npm run lint
```

Expected: clean (this also proves Task 1's dynamic `import("./supabase")` now resolves).

- [ ] Run the full suite to confirm nothing regressed:

```bash
npm test -- --no-file-parallelism
```

- [ ] Commit:

```bash
git add src/lib/storage/supabase.ts "src/app/api/dev/storage/[...key]/route.ts" "src/app/api/admin/files/[...key]/route.ts"
git commit -m "feat(storage): supabase driver, dev signed route, same-origin admin file streaming"
```

---

### Task 3: Inspections schema + balance payment type migration

**Files:**
- Create: `src/lib/db/schema/inspections.ts`
- Modify: `src/lib/db/schema/index.ts` (add export)
- Modify: `src/lib/db/schema/payments.ts` (append `'balance'` to the `payment_type` pgEnum)
- Create: next-numbered migration in `./drizzle` (via `npm run db:generate`; hand-written fallback below)
- Test: `src/test/inspections-schema.test.ts`

**Interfaces:**
- Consumes: `bookings` from `@/lib/db/schema/bookings`, `adminUsers` from `@/lib/db/schema/admin`.
- Produces (seams-doc canonical, verbatim):
  - drizzle table `inspections` with properties `id, bookingId, kind, odometer, fuelLevel, notes, photos, licensePhotoKey, signatureKey, contractPdfKey, damageFlags, acceptedPolicyVersion, agreementSigned, rulesSigned, licenseCopyReceived, borgReceivedCents, borgMethod, borgReturnedCents, borgWithheldCents, borgWithheldReason, keysReturned, createdBy, createdAt`; UNIQUE `(bookingId, kind)`
  - pgEnum `inspection_kind` (`'pickup' | 'return'`)
  - exported types `InspectionPhoto { key: string; label: string }`, `DamageFlag { photoKey: string; note: string }`
  - `payment_type` enum additionally accepts `'balance'` (plan-local, additive: desk-collected balance at check-in; plan 02's `'extension'` untouched)

**Steps:**

- [ ] Write the failing test `src/test/inspections-schema.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, payments, adminUsers, inspections } from "@/lib/db/schema";
import { expectReject } from "./util";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "", adminId = "", bookingId = "";

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "insp-car", plate: "PL-insp", class: "SUV", name: "Insp Car", seats: 5,
    transmission: "Automatic", doors: 5, priceDayCents: 10000, priceWeekCents: 60000,
    priceMonthCents: 200000, depositCents: 25000,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "insp-schema@test.com" }).returning();
  const [a] = await db.insert(adminUsers).values({ email: "insp-schema-admin@test.com", passwordHash: "x" }).returning();
  vehicleId = v!.id; customerId = c!.id; adminId = a!.id;
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt: new Date("2026-08-01T13:00:00Z"),
    endAt: new Date("2026-08-05T13:00:00Z"),
    bufferEndAt: new Date("2026-08-06T13:00:00Z"),
    status: "confirmed",
    priceBreakdown: { subtotalCents: 40000, currency: "USD" },
    paymentOption: "deposit", acceptedPolicyVersion: 1, acceptedAt: new Date(),
    idempotencyKey: "insp-schema-1",
  }).returning();
  bookingId = b!.id;
});

describe("inspections table", () => {
  it("stores a pickup inspection with checklist defaults", async () => {
    const [row] = await db.insert(inspections).values({ bookingId, kind: "pickup", createdBy: adminId }).returning();
    expect(row!.agreementSigned).toBe(false);
    expect(row!.rulesSigned).toBe(false);
    expect(row!.licenseCopyReceived).toBe(false);
    expect(row!.keysReturned).toBe(false);
    expect(row!.photos).toEqual([]);
    expect(row!.damageFlags).toEqual([]);
    expect(row!.borgReceivedCents).toBeNull();
  });

  it("enforces ONE inspection per booking per kind", async () => {
    await expectReject(
      db.insert(inspections).values({ bookingId, kind: "pickup", createdBy: adminId }),
      /inspections_booking_kind|duplicate key/i,
    );
  });

  it("rejects a fuel level outside 0..8", async () => {
    await expectReject(
      db.insert(inspections).values({ bookingId, kind: "return", createdBy: adminId, fuelLevel: 9 }),
      /inspections_fuel_level|check constraint/i,
    );
  });

  it("accepts a desk 'balance' payment row (new enum value)", async () => {
    const [p] = await db.insert(payments).values({
      bookingId, type: "balance", method: "desk", amountCents: 1000, currency: "USD", status: "succeeded",
    }).returning();
    expect(p!.type).toBe("balance");
    expect(p!.method).toBe("desk");
  });
});
```

- [ ] Run it to verify it fails:

```bash
npm test -- --no-file-parallelism src/test/inspections-schema.test.ts
```

Expected failure: `inspections` is not exported from `@/lib/db/schema`.

- [ ] Create `src/lib/db/schema/inspections.ts`:

```ts
import { pgTable, pgEnum, text, integer, smallint, boolean, timestamp, uuid, jsonb, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bookings } from "./bookings";
import { adminUsers } from "./admin";

export const inspectionKind = pgEnum("inspection_kind", ["pickup", "return"]);

export interface InspectionPhoto { key: string; label: string }
export interface DamageFlag { photoKey: string; note: string }

/**
 * One row per booking per kind (pickup | return) — the check-in/check-out
 * record (spec W4). Photos/licence/signature are STORAGE KEYS into the private
 * object store, never URLs. Checklist booleans render as single-tap toggles in
 * the BookingDrawer; borg (security deposit) amounts feed the reports
 * workstream. fuelLevel is eighths of a tank: 0 = empty .. 8 = full.
 */
export const inspections = pgTable("inspections", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookingId: uuid("booking_id").notNull().references(() => bookings.id, { onDelete: "cascade" }),
  kind: inspectionKind("kind").notNull(),
  odometer: integer("odometer"),
  fuelLevel: smallint("fuel_level"),
  notes: text("notes").notNull().default(""),
  photos: jsonb("photos").$type<InspectionPhoto[]>().notNull().default(sql`'[]'::jsonb`),
  licensePhotoKey: text("license_photo_key"),
  signatureKey: text("signature_key"),
  contractPdfKey: text("contract_pdf_key"),
  damageFlags: jsonb("damage_flags").$type<DamageFlag[]>().notNull().default(sql`'[]'::jsonb`),
  acceptedPolicyVersion: integer("accepted_policy_version"),
  agreementSigned: boolean("agreement_signed").notNull().default(false),
  rulesSigned: boolean("rules_signed").notNull().default(false),
  licenseCopyReceived: boolean("license_copy_received").notNull().default(false),
  borgReceivedCents: integer("borg_received_cents"),
  borgMethod: text("borg_method"), // 'cash' | 'card' (validated by zod at the boundary)
  borgReturnedCents: integer("borg_returned_cents"),
  borgWithheldCents: integer("borg_withheld_cents"),
  borgWithheldReason: text("borg_withheld_reason"),
  keysReturned: boolean("keys_returned").notNull().default(false),
  createdBy: uuid("created_by").notNull().references(() => adminUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("inspections_booking_kind").on(t.bookingId, t.kind),
  check("inspections_fuel_level", sql`${t.fuelLevel} IS NULL OR (${t.fuelLevel} >= 0 AND ${t.fuelLevel} <= 8)`),
]);
```

- [ ] Register the export in `src/lib/db/schema/index.ts` — append at the end of the export list:

```ts
export * from "./inspections";
```

- [ ] Add the `'balance'` payment type in `src/lib/db/schema/payments.ts`. The `paymentType` pgEnum array currently contains `"reservation_fee", "deposit"` plus `"extension"` (added by plan 02). Append `"balance"` as the LAST element, e.g.:

```ts
export const paymentType = pgEnum("payment_type", ["reservation_fee", "deposit", "extension", "balance"]);
```

(Keep the existing values in their existing order; only append. Postgres enum ADD VALUE is append-only.)

- [ ] Generate the migration:

```bash
npm run db:generate
```

Then open the newly created file in `./drizzle` (the next-numbered one) and verify it contains ONLY additive statements: `CREATE TYPE "public"."inspection_kind" ...`, `ALTER TYPE "public"."payment_type" ADD VALUE 'balance' ...`, `CREATE TABLE "inspections" ...` (with the two FKs, the unique index `inspections_booking_kind`, and the check `inspections_fuel_level`). If drizzle-kit instead proposes anything destructive (DROP/recreate of `payment_type` or any other table), DELETE the generated file and its `drizzle/meta/_journal.json` entry plus snapshot, and hand-write the next-numbered SQL file in `./drizzle` (register it in `drizzle/meta/_journal.json` following the existing entry pattern: `{ "idx": <next>, "version": "7", "when": <epoch-ms>, "tag": "<filename-without-.sql>", "breakpoints": true }`) with this body:

```sql
CREATE TYPE "public"."inspection_kind" AS ENUM('pickup', 'return');--> statement-breakpoint
ALTER TYPE "public"."payment_type" ADD VALUE 'balance';--> statement-breakpoint
CREATE TABLE "inspections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "booking_id" uuid NOT NULL,
  "kind" "inspection_kind" NOT NULL,
  "odometer" integer,
  "fuel_level" smallint,
  "notes" text DEFAULT '' NOT NULL,
  "photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "license_photo_key" text,
  "signature_key" text,
  "contract_pdf_key" text,
  "damage_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "accepted_policy_version" integer,
  "agreement_signed" boolean DEFAULT false NOT NULL,
  "rules_signed" boolean DEFAULT false NOT NULL,
  "license_copy_received" boolean DEFAULT false NOT NULL,
  "borg_received_cents" integer,
  "borg_method" text,
  "borg_returned_cents" integer,
  "borg_withheld_cents" integer,
  "borg_withheld_reason" text,
  "keys_returned" boolean DEFAULT false NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inspections_fuel_level" CHECK ("fuel_level" IS NULL OR ("fuel_level" >= 0 AND "fuel_level" <= 8))
);--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inspections_booking_kind" ON "inspections" USING btree ("booking_id","kind");
```

- [ ] Run the test to verify it passes:

```bash
npm test -- --no-file-parallelism src/test/inspections-schema.test.ts
```

Expected: 4 tests pass (migrations apply into PGlite, unique + check constraints fire).

- [ ] Run the FULL suite (other tests run migrations too; a broken migration breaks everything):

```bash
npm test -- --no-file-parallelism
```

- [ ] Commit:

```bash
git add src/lib/db/schema drizzle src/test/inspections-schema.test.ts
git commit -m "feat(inspections): inspections table, inspection_kind enum, desk balance payment type"
```

---

### Task 4: Upload validation + POST /api/admin/uploads

**Files:**
- Create: `src/lib/storage/uploads.ts`
- Create: `src/app/api/admin/uploads/route.ts`
- Test: `src/test/upload-validation.test.ts`

**Interfaces:**
- Consumes: `putObject` from `@/lib/storage` (Task 1); `mutate` from `@/lib/admin/guard` (`mutate(req, action, fn)` where `fn(ctx)` returns `{ result, entity, entityId?, before?, after? }`; `ctx.admin.id` is the acting admin's uuid; CSRF is enforced by `requireAdmin` inside on unsafe methods via the `X-CSRF-Token` header, which works fine with multipart bodies); `withRoute`, `json` from `@/lib/http/respond` (`json(data, req, { status })`), `parseParams` from `@/lib/http/validate` (zod-validate a plain object, throws 422), `Errors`; `bookings`, `getDb` for the existence check.
- Produces:
  - `POST /api/admin/uploads` — multipart form fields: `file` (required, jpeg/png/webp, ≤ 10 MB), `category` (`'inspection'|'license'|'signature'`), `bookingId` (uuid), `kind` (`'pickup'|'return'`, required when category=inspection), `label` (optional, ≤ 120 chars). Responds `201 { key: string }`. Audit action `admin.file_uploaded`.
  - `MAX_UPLOAD_BYTES = 10 * 1024 * 1024`, `validateUploadFile(file: { size: number; type: string }): void`, `buildUploadKey(fields: UploadFields): string`, `UploadFieldsSchema` in `@/lib/storage/uploads`.
  - Key formats (seams-doc verbatim): `inspections/{bookingId}/{kind}/{uuid}.jpg`, `licenses/{bookingId}/{uuid}.jpg`, `signatures/{bookingId}.png` (deterministic: re-signing overwrites).

**Steps:**

- [ ] Write the failing test `src/test/upload-validation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateUploadFile, buildUploadKey, MAX_UPLOAD_BYTES, UploadFieldsSchema } from "@/lib/storage/uploads";

const BOOKING = "0b6f37cc-9db1-4a10-a1d8-6f8f6f0f2a11";

describe("upload validation", () => {
  it("accepts a normal jpeg", () => {
    expect(() => validateUploadFile({ size: 500_000, type: "image/jpeg" })).not.toThrow();
  });

  it("rejects empty, oversized, and wrong-type files", () => {
    expect(() => validateUploadFile({ size: 0, type: "image/jpeg" })).toThrow(/empty/i);
    expect(() => validateUploadFile({ size: MAX_UPLOAD_BYTES + 1, type: "image/jpeg" })).toThrow(/10 MB/);
    expect(() => validateUploadFile({ size: 1000, type: "application/pdf" })).toThrow(/JPEG, PNG, or WebP/);
    expect(() => validateUploadFile({ size: 1000, type: "image/gif" })).toThrow(/JPEG, PNG, or WebP/);
  });

  it("builds seams-format keys per category", () => {
    const insp = buildUploadKey({ category: "inspection", bookingId: BOOKING, kind: "pickup", label: "" });
    expect(insp).toMatch(new RegExp(`^inspections/${BOOKING}/pickup/[0-9a-f-]{36}\\.jpg$`));
    const lic = buildUploadKey({ category: "license", bookingId: BOOKING, label: "" });
    expect(lic).toMatch(new RegExp(`^licenses/${BOOKING}/[0-9a-f-]{36}\\.jpg$`));
    const sig = buildUploadKey({ category: "signature", bookingId: BOOKING, label: "" });
    expect(sig).toBe(`signatures/${BOOKING}.png`);
  });

  it("requires kind for inspection photos", () => {
    expect(() => buildUploadKey({ category: "inspection", bookingId: BOOKING, label: "" })).toThrow(/kind/);
  });

  it("schema rejects a non-uuid bookingId and an unknown category", () => {
    expect(UploadFieldsSchema.safeParse({ category: "inspection", bookingId: "nope", kind: "pickup" }).success).toBe(false);
    expect(UploadFieldsSchema.safeParse({ category: "weird", bookingId: BOOKING }).success).toBe(false);
    expect(UploadFieldsSchema.safeParse({ category: "license", bookingId: BOOKING }).success).toBe(true);
  });
});
```

- [ ] Run it to verify it fails:

```bash
npm test -- --no-file-parallelism src/test/upload-validation.test.ts
```

Expected failure: `Failed to resolve import "@/lib/storage/uploads"`.

- [ ] Create `src/lib/storage/uploads.ts`:

```ts
/**
 * Upload policy for POST /api/admin/uploads: what may be uploaded, how big,
 * and where it lives in the key space. Key formats are canonical (seams doc):
 *   inspections/{bookingId}/{kind}/{uuid}.jpg
 *   licenses/{bookingId}/{uuid}.jpg
 *   signatures/{bookingId}.png       (deterministic — re-signing overwrites)
 * Contract PDFs are server-generated (never uploaded) at contracts/{bookingId}.pdf.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Errors } from "@/lib/http/errors";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // ~10MB cap (spec W4)

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export const UploadFieldsSchema = z.object({
  category: z.enum(["inspection", "license", "signature"]),
  bookingId: z.string().uuid(),
  kind: z.enum(["pickup", "return"]).optional(),
  label: z.string().trim().max(120).optional().default(""),
}).strict();

export type UploadFields = z.infer<typeof UploadFieldsSchema>;

export function validateUploadFile(file: { size: number; type: string }): void {
  if (file.size === 0) throw Errors.badRequest("The uploaded file is empty");
  if (file.size > MAX_UPLOAD_BYTES) throw Errors.badRequest("Photos must be under 10 MB");
  if (!ALLOWED_TYPES.has(file.type)) throw Errors.badRequest("Only JPEG, PNG, or WebP images are accepted");
}

export function buildUploadKey(fields: UploadFields): string {
  switch (fields.category) {
    case "inspection":
      if (!fields.kind) throw Errors.badRequest("kind is required for inspection photos");
      return `inspections/${fields.bookingId}/${fields.kind}/${randomUUID()}.jpg`;
    case "license":
      return `licenses/${fields.bookingId}/${randomUUID()}.jpg`;
    case "signature":
      return `signatures/${fields.bookingId}.png`;
  }
}
```

- [ ] Run the test to verify it passes:

```bash
npm test -- --no-file-parallelism src/test/upload-validation.test.ts
```

Expected: 5 tests pass.

- [ ] Create `src/app/api/admin/uploads/route.ts`:

```ts
import { eq } from "drizzle-orm";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { Errors } from "@/lib/http/errors";
import { getDb } from "@/lib/db/client";
import { bookings } from "@/lib/db/schema";
import { putObject } from "@/lib/storage";
import { UploadFieldsSchema, validateUploadFile, buildUploadKey } from "@/lib/storage/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/uploads — multipart upload for check-in/out media.
 * Fields: file (jpeg/png/webp, <= 10MB), category, bookingId, kind?, label?.
 * The client downscales photos before upload (canvas, longest edge ~1600px),
 * so 10MB is a hard backstop, not the normal case. CSRF: the client sends the
 * X-CSRF-Token header alongside the multipart body (never set Content-Type
 * manually — the browser adds the multipart boundary).
 */
export const POST = withRoute(async (req) => {
  const result = await mutate(req, "admin.file_uploaded", async () => {
    const form = await req.formData().catch(() => {
      throw Errors.badRequest("Expected multipart form data");
    });
    const file = form.get("file");
    if (!(file instanceof File)) throw Errors.badRequest("file field is required");
    const fields = parseParams({
      category: form.get("category"),
      bookingId: form.get("bookingId"),
      kind: form.get("kind") ?? undefined,
      label: form.get("label") ?? undefined,
    }, UploadFieldsSchema);
    validateUploadFile(file);

    const db = await getDb();
    const [booking] = await db.select({ id: bookings.id }).from(bookings).where(eq(bookings.id, fields.bookingId));
    if (!booking) throw Errors.notFound("Booking not found");

    const key = buildUploadKey(fields);
    await putObject(key, new Uint8Array(await file.arrayBuffer()), file.type);
    return {
      result: { key },
      entity: "upload",
      entityId: fields.bookingId,
      after: { key, category: fields.category, label: fields.label, bytes: file.size },
    };
  });
  return json(result, req, { status: 201 });
});
```

- [ ] Typecheck and lint:

```bash
npx tsc --noEmit && npm run lint
```

- [ ] Commit:

```bash
git add src/lib/storage/uploads.ts src/app/api/admin/uploads src/test/upload-validation.test.ts
git commit -m "feat(uploads): admin multipart upload endpoint with size/type caps and seams key formats"
```

---

### Task 5: Status transitions, inspection upsert, desk balance payment

**Files:**
- Create: `src/lib/booking/transitions.ts`
- Create: `src/lib/admin/inspections.ts` (first slice: schema, upsert, desk payment, handover)
- Modify: `src/lib/admin/move-booking.ts` (harden `cancelBookingAdmin` against `picked_up`)
- Test: `src/test/inspections.test.ts`

**Interfaces:**
- Consumes: drizzle tables `bookings, vehicles, customers, payments, inspections, driverLicenses` from `@/lib/db/schema`; `getDb` from `@/lib/db/client`; `Errors`; `getLatestPolicy` from `@/lib/admin/policies` (`getLatestPolicy("rental_terms"): Promise<{ version: number; body: string; ... } | undefined>`); `QuoteBreakdown` type from `@/lib/booking/quote` (has `subtotalCents, vehicleCents, insuranceCents, addOns: {id,name,qty,cents}[], days, currency`, plus `youngDriverCents` after plan 05).
- Produces:
  - `assertBookingTransition(from: string, to: string): void` in `src/lib/booking/transitions.ts` — throws 409 unless the move is in `pending→{confirmed,cancelled,picked_up}`, `confirmed→{picked_up,cancelled}`, `picked_up→{completed}`.
  - In `src/lib/admin/inspections.ts`:
    - `InspectionPatchSchema` (zod, `.strict()`, all fields optional) and type `InspectionPatch`
    - `type Inspection = typeof inspections.$inferSelect`
    - `upsertInspection(bookingId: string, kind: "pickup" | "return", patch: InspectionPatch, actorId: string): Promise<{ before: Inspection | null; after: Inspection }>`
    - `recordDeskBalancePayment(bookingId: string, amountCents: number, actorId: string): Promise<typeof bookings.$inferSelect>`
    - `getHandover(bookingId: string): Promise<HandoverPayload>` + exported `HandoverPayload`/`HandoverPriceLine` interfaces (exact shape below — the wizards and drawer panel consume it)
    - `REQUIRED_ANGLES = ["front", "back", "left", "right", "interior", "dash"] as const`
    - `fuelEighthsLabel(v: number | null): string`

**Steps:**

- [ ] Write the failing test `src/test/inspections.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, payments, adminUsers } from "@/lib/db/schema";
import { assertBookingTransition } from "@/lib/booking/transitions";
import { upsertInspection, recordDeskBalancePayment, getHandover } from "@/lib/admin/inspections";
import { cancelBookingAdmin } from "@/lib/admin/move-booking";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "", adminId = "";
let month = 1;

async function mkBooking(key: string, status: "pending" | "confirmed" | "picked_up" | "completed" | "cancelled") {
  const m = String(month++).padStart(2, "0");
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt: new Date(`2027-${m}-01T13:00:00Z`),
    endAt: new Date(`2027-${m}-05T13:00:00Z`),
    bufferEndAt: new Date(`2027-${m}-06T13:00:00Z`),
    status,
    priceBreakdown: { subtotalCents: 40000, vehicleCents: 40000, insuranceCents: 0, addOns: [], addOnsCents: 0, days: 4, currency: "USD" },
    paymentOption: "deposit", acceptedPolicyVersion: 1, acceptedAt: new Date(),
    idempotencyKey: key,
  }).returning();
  return b!;
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "insp-lib-car", plate: "PL-insp-lib", class: "SUV", name: "Insp Lib Car", seats: 5,
    transmission: "Automatic", doors: 5, priceDayCents: 10000, priceWeekCents: 60000,
    priceMonthCents: 200000, depositCents: 25000,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "insp-lib@test.com" }).returning();
  const [a] = await db.insert(adminUsers).values({ email: "insp-lib-admin@test.com", passwordHash: "x" }).returning();
  vehicleId = v!.id; customerId = c!.id; adminId = a!.id;
});

describe("assertBookingTransition", () => {
  it("allows the wave's lifecycle and nothing else", () => {
    expect(() => assertBookingTransition("confirmed", "picked_up")).not.toThrow();
    expect(() => assertBookingTransition("pending", "picked_up")).not.toThrow();
    expect(() => assertBookingTransition("picked_up", "completed")).not.toThrow();
    expect(() => assertBookingTransition("picked_up", "cancelled")).toThrow();
    expect(() => assertBookingTransition("completed", "picked_up")).toThrow();
    expect(() => assertBookingTransition("cancelled", "picked_up")).toThrow();
    expect(() => assertBookingTransition("confirmed", "completed")).toThrow();
  });
});

describe("upsertInspection", () => {
  it("creates the row on first write and patches on later writes", async () => {
    const b = await mkBooking("insp-upsert-1", "confirmed");
    const first = await upsertInspection(b.id, "pickup", { odometer: 41250 }, adminId);
    expect(first.after.odometer).toBe(41250);
    expect(first.after.agreementSigned).toBe(false);
    const second = await upsertInspection(b.id, "pickup", { agreementSigned: true, fuelLevel: 6 }, adminId);
    expect(second.before?.odometer).toBe(41250);
    expect(second.after.agreementSigned).toBe(true);
    expect(second.after.fuelLevel).toBe(6);
    expect(second.after.id).toBe(first.after.id); // same row, no duplicate
  });

  it("rejects a return inspection before the car is out", async () => {
    const b = await mkBooking("insp-upsert-2", "confirmed");
    await expect(upsertInspection(b.id, "return", { odometer: 1 }, adminId)).rejects.toThrow(/check the car in/i);
  });

  it("rejects inspections on a cancelled booking", async () => {
    const b = await mkBooking("insp-upsert-3", "cancelled");
    await expect(upsertInspection(b.id, "pickup", { odometer: 1 }, adminId)).rejects.toThrow(/cancelled/i);
  });
});

describe("recordDeskBalancePayment", () => {
  it("adds a desk 'balance' payment and bumps amountPaidCents", async () => {
    const b = await mkBooking("insp-desk-1", "confirmed");
    const updated = await recordDeskBalancePayment(b.id, 40000, adminId);
    expect(updated.amountPaidCents).toBe(40000);
    const rows = await db.select().from(payments).where(eq(payments.bookingId, b.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("balance");
    expect(rows[0]!.method).toBe("desk");
    expect(rows[0]!.status).toBe("succeeded");
  });

  it("refuses to collect more than the open balance", async () => {
    const b = await mkBooking("insp-desk-2", "confirmed");
    await expect(recordDeskBalancePayment(b.id, 40001, adminId)).rejects.toThrow(/more than the open balance/i);
  });
});

describe("getHandover", () => {
  it("returns booking, vehicle, customer, balance, and inspection slots", async () => {
    const b = await mkBooking("insp-handover-1", "confirmed");
    await upsertInspection(b.id, "pickup", { odometer: 5 }, adminId);
    const h = await getHandover(b.id);
    expect(h.booking.id).toBe(b.id);
    expect(h.booking.balanceDueCents).toBe(40000);
    expect(h.vehicle.plate).toBe("PL-insp-lib");
    expect(h.customer.email).toBe("insp-lib@test.com");
    expect(h.inspections.pickup?.odometer).toBe(5);
    expect(h.inspections.return).toBeNull();
    expect(h.license).toBeNull();
    expect(h.booking.priceLines[0]!.cents).toBe(40000);
  });
});

describe("cancelBookingAdmin transition guard", () => {
  it("refuses to cancel a picked_up booking (the car is out)", async () => {
    const b = await mkBooking("insp-cancel-1", "picked_up");
    await expect(cancelBookingAdmin(b.id)).rejects.toThrow(/no longer be cancelled/i);
  });
});
```

- [ ] Run it to verify it fails:

```bash
npm test -- --no-file-parallelism src/test/inspections.test.ts
```

Expected failure: `Failed to resolve import "@/lib/booking/transitions"`.

- [ ] Create `src/lib/booking/transitions.ts`:

```ts
/**
 * The single source of truth for booking status moves this wave:
 *   pending -> confirmed -> picked_up -> completed   (+ cancelled from
 *   pending/confirmed only; a car that is OUT cannot be "cancelled", it must
 *   come back through check-out). pending -> picked_up is the desk override
 *   path (completePickup additionally requires an override note for it).
 */
import { Errors } from "@/lib/http/errors";

const ALLOWED: Record<string, string[]> = {
  pending: ["confirmed", "cancelled", "picked_up"],
  confirmed: ["picked_up", "cancelled"],
  picked_up: ["completed"],
  cancelled: [],
  completed: [],
};

export function assertBookingTransition(from: string, to: string): void {
  if (!(ALLOWED[from] ?? []).includes(to)) {
    throw Errors.conflict(`A ${from.replace(/_/g, " ")} booking cannot move to ${to.replace(/_/g, " ")}`);
  }
}
```

- [ ] Create `src/lib/admin/inspections.ts` (first slice — Task 8 appends the complete/finalize functions to this same file):

```ts
/**
 * Check-in / check-out domain logic (spec W4). The inspection row is the
 * durable record of the handover: photos (storage keys), checklist booleans,
 * odometer/fuel, borg amounts, signature, contract. All writes flow through
 * the audited admin routes; this module owns validation + transactions.
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, vehicles, customers, payments, inspections, driverLicenses } from "@/lib/db/schema";
import { Errors } from "@/lib/http/errors";
import { getLatestPolicy } from "@/lib/admin/policies";
import type { QuoteBreakdown } from "@/lib/booking/quote";

export type Inspection = typeof inspections.$inferSelect;
export type BookingRow = typeof bookings.$inferSelect;

export const REQUIRED_ANGLES = ["front", "back", "left", "right", "interior", "dash"] as const;

const FUEL_EIGHTHS = ["Empty", "1/8", "1/4", "3/8", "1/2", "5/8", "3/4", "7/8", "Full"];
export function fuelEighthsLabel(v: number | null): string {
  return v === null ? "" : FUEL_EIGHTHS[v] ?? String(v);
}

export const money = (cents: number, currency: string) => `${currency} ${(cents / 100).toFixed(2)}`;

const storageKey = z.string().min(1).max(300);

export const InspectionPatchSchema = z.object({
  odometer: z.number().int().min(0).max(2_000_000).optional(),
  fuelLevel: z.number().int().min(0).max(8).optional(),
  notes: z.string().trim().max(4000).optional(),
  photos: z.array(z.object({ key: storageKey, label: z.string().trim().min(1).max(120) }).strict()).max(40).optional(),
  licensePhotoKey: storageKey.nullable().optional(),
  signatureKey: storageKey.nullable().optional(),
  damageFlags: z.array(z.object({ photoKey: z.string().max(300), note: z.string().trim().min(1).max(500) }).strict()).max(40).optional(),
  acceptedPolicyVersion: z.number().int().min(0).optional(),
  agreementSigned: z.boolean().optional(),
  rulesSigned: z.boolean().optional(),
  licenseCopyReceived: z.boolean().optional(),
  borgReceivedCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  borgMethod: z.enum(["cash", "card"]).nullable().optional(),
  borgReturnedCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  borgWithheldCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  borgWithheldReason: z.string().trim().max(500).nullable().optional(),
  keysReturned: z.boolean().optional(),
}).strict();

export type InspectionPatch = z.infer<typeof InspectionPatchSchema>;

/** Create-or-update the draft inspection for (booking, kind). Returns before/after for the audit log. */
export async function upsertInspection(
  bookingId: string,
  kind: "pickup" | "return",
  patch: InspectionPatch,
  actorId: string,
): Promise<{ before: Inspection | null; after: Inspection }> {
  const db = await getDb();
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!booking) throw Errors.notFound("Booking not found");
  if (booking.status === "cancelled") throw Errors.conflict("A cancelled booking cannot be inspected");
  if (kind === "return" && booking.status !== "picked_up" && booking.status !== "completed") {
    throw Errors.conflict("Check the car in before starting a return inspection");
  }

  await db.insert(inspections)
    .values({ bookingId, kind, createdBy: actorId })
    .onConflictDoNothing({ target: [inspections.bookingId, inspections.kind] });
  const [before] = await db.select().from(inspections)
    .where(and(eq(inspections.bookingId, bookingId), eq(inspections.kind, kind)));
  if (!before) throw Errors.notFound("Inspection row missing"); // unreachable after the insert above

  if (Object.keys(patch).length === 0) return { before, after: before };
  const [after] = await db.update(inspections)
    .set(patch)
    .where(eq(inspections.id, before.id))
    .returning();
  return { before, after: after! };
}

/**
 * The check-in "balance collected at desk" action: one succeeded desk payment
 * row (type 'balance', method 'desk') plus the amountPaidCents bump, atomically.
 */
export async function recordDeskBalancePayment(
  bookingId: string,
  amountCents: number,
  actorId: string,
): Promise<BookingRow> {
  void actorId; // actor lands in the audit log via mutate(); kept in the signature for symmetry
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
    if (!booking) throw Errors.notFound("Booking not found");
    if (booking.status === "cancelled" || booking.status === "completed") {
      throw Errors.conflict("This booking can no longer take payments");
    }
    const breakdown = booking.priceBreakdown as Partial<QuoteBreakdown>;
    const balance = Math.max(0, (breakdown.subtotalCents ?? 0) - booking.amountPaidCents);
    if (amountCents <= 0) throw Errors.badRequest("Amount must be positive");
    if (amountCents > balance) throw Errors.badRequest("That is more than the open balance");
    await tx.insert(payments).values({
      bookingId, type: "balance", method: "desk", amountCents,
      currency: breakdown.currency ?? "USD", status: "succeeded",
    });
    const [updated] = await tx.update(bookings)
      .set({ amountPaidCents: booking.amountPaidCents + amountCents, updatedAt: new Date() })
      .where(eq(bookings.id, bookingId))
      .returning();
    return updated!;
  });
}

export interface HandoverPriceLine { label: string; cents: number }

export interface HandoverPayload {
  booking: {
    id: string; status: string; source: string; notes: string | null;
    startAt: string; endAt: string; currency: string;
    subtotalCents: number; amountPaidCents: number; balanceDueCents: number;
    priceLines: HandoverPriceLine[];
  };
  vehicle: { id: string; name: string; plate: string; class: string; depositCents: number | null };
  customer: { name: string | null; email: string; phone: string | null };
  license: { nameOnLicense: string; issuingCountry: string; expiryDate: string } | null;
  policy: { version: number; body: string } | null;
  inspections: { pickup: Inspection | null; return: Inspection | null };
}

/** Everything both wizards and the drawer panel need, in ONE read (less clicking). */
export async function getHandover(bookingId: string): Promise<HandoverPayload> {
  const db = await getDb();
  const [row] = await db.select({ booking: bookings, vehicle: vehicles, customer: customers })
    .from(bookings)
    .innerJoin(vehicles, eq(bookings.vehicleId, vehicles.id))
    .innerJoin(customers, eq(bookings.customerId, customers.id))
    .where(eq(bookings.id, bookingId));
  if (!row) throw Errors.notFound("Booking not found");
  const b = row.booking;

  const [license] = await db.select({
    nameOnLicense: driverLicenses.nameOnLicense,
    issuingCountry: driverLicenses.issuingCountry,
    expiryDate: driverLicenses.expiryDate,
  }).from(driverLicenses).where(eq(driverLicenses.bookingId, bookingId));

  const policy = await getLatestPolicy("rental_terms");
  const insp = await db.select().from(inspections).where(eq(inspections.bookingId, bookingId));

  const breakdown = b.priceBreakdown as Partial<QuoteBreakdown> & { youngDriverCents?: number };
  const subtotal = breakdown.subtotalCents ?? 0;
  const priceLines: HandoverPriceLine[] = [
    {
      label: breakdown.days ? `Vehicle (${breakdown.days} day${breakdown.days === 1 ? "" : "s"})` : "Vehicle",
      cents: breakdown.vehicleCents ?? subtotal,
    },
    ...(breakdown.insuranceCents ? [{ label: "Insurance", cents: breakdown.insuranceCents }] : []),
    ...(breakdown.addOns ?? []).map((a) => ({ label: `${a.name} x${a.qty}`, cents: a.cents })),
    ...(breakdown.youngDriverCents ? [{ label: "Young driver fee", cents: breakdown.youngDriverCents }] : []),
  ];

  return {
    booking: {
      id: b.id, status: b.status, source: b.source, notes: b.notes,
      startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(),
      currency: breakdown.currency ?? "USD",
      subtotalCents: subtotal,
      amountPaidCents: b.amountPaidCents,
      balanceDueCents: Math.max(0, subtotal - b.amountPaidCents),
      priceLines,
    },
    vehicle: {
      id: row.vehicle.id, name: row.vehicle.name, plate: row.vehicle.plate,
      class: row.vehicle.class, depositCents: row.vehicle.depositCents,
    },
    customer: { name: row.customer.name, email: row.customer.email, phone: row.customer.phone },
    license: license ?? null,
    policy: policy ? { version: policy.version, body: policy.body } : null,
    inspections: {
      pickup: insp.find((i) => i.kind === "pickup") ?? null,
      return: insp.find((i) => i.kind === "return") ?? null,
    },
  };
}
```

Note on `customers` fields: the table has nullable `name` and `phone` columns (booking creation fills them; a bare test insert leaves them null), which is why `HandoverPayload.customer` types them nullable. If typecheck reveals `customers.name`/`customers.phone` are NOT NULL with defaults in this codebase, keep the payload type as-is (`string | null` accepts both).

- [ ] Harden `cancelBookingAdmin` in `src/lib/admin/move-booking.ts`. Its guard currently reads:

```ts
  if (booking.status === "cancelled" || booking.status === "completed") {
    throw Errors.conflict("This booking can no longer be cancelled");
  }
```

Replace with (allow-list instead of deny-list, so `picked_up` is also rejected):

```ts
  if (booking.status !== "pending" && booking.status !== "confirmed") {
    throw Errors.conflict("This booking can no longer be cancelled");
  }
```

(If plan 02 already reworked `cancelBookingAdmin` for the refund flow, do not fight its structure; just make sure whatever guard it has rejects `picked_up` with a 409 whose message matches `/no longer be cancelled/i`.)

- [ ] Run the test to verify it passes:

```bash
npm test -- --no-file-parallelism src/test/inspections.test.ts
```

Expected: all tests pass.

- [ ] Commit:

```bash
git add src/lib/booking/transitions.ts src/lib/admin/inspections.ts src/lib/admin/move-booking.ts src/test/inspections.test.ts
git commit -m "feat(inspections): transitions guard, inspection upsert, desk balance payment, handover read"
```

---

### Task 6: Contract PDF renderer

**Files:**
- Create: `src/lib/pdf/contract.tsx`
- Test: `src/test/pdf-contract.test.ts`

**Interfaces:**
- Consumes: `@react-pdf/renderer` (installed in Task 1).
- Produces (seams-doc canonical): `renderContractPdf(data: ContractData): Promise<Uint8Array>` in `src/lib/pdf/contract.tsx`, plus the exported `ContractData` interface below. Plan 07 reuses the dependency for reports; it does NOT import this file.

**Steps:**

- [ ] Write the failing test `src/test/pdf-contract.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderContractPdf, type ContractData } from "@/lib/pdf/contract";

const data: ContractData = {
  operatorName: "FleetDesk",
  contractRef: "AB12CD34",
  generatedAt: "Aug 1, 2026 at 09:00",
  customerName: "Jane Tester",
  customerEmail: "jane@test.com",
  customerPhone: "+297 555 0100",
  driverName: "Jane Tester",
  licenseCountry: "Netherlands",
  vehicleName: "Kia Sportage",
  vehiclePlate: "A-12345",
  vehicleClass: "SUV",
  periodStart: "Aug 1, 2026 at 09:00",
  periodEnd: "Aug 5, 2026 at 09:00",
  lines: [
    { label: "Vehicle (4 days)", amount: "USD 400.00" },
    { label: "Insurance", amount: "USD 60.00" },
  ],
  totalAmount: "USD 460.00",
  paidAmount: "USD 460.00",
  balanceDue: "USD 0.00",
  borgLine: "USD 250.00 received in cash (refundable at return)",
  policyVersion: 3,
  policyText: "Drive nicely. Bring it back with the same fuel level.",
  signaturePngDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  photoCount: 6,
  odometer: "41250",
  fuel: "3/4",
};

describe("renderContractPdf", () => {
  it("renders a real PDF byte stream", async () => {
    const bytes = await renderContractPdf(data);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(Buffer.from(bytes.slice(0, 5)).toString("ascii")).toBe("%PDF-");
  });

  it("renders without a signature image too", async () => {
    const bytes = await renderContractPdf({ ...data, signaturePngDataUrl: null });
    expect(Buffer.from(bytes.slice(0, 5)).toString("ascii")).toBe("%PDF-");
  });
});
```

- [ ] Run it to verify it fails:

```bash
npm test -- --no-file-parallelism src/test/pdf-contract.test.ts
```

Expected failure: `Failed to resolve import "@/lib/pdf/contract"`.

- [ ] Create `src/lib/pdf/contract.tsx`:

```tsx
/**
 * Rental contract PDF (spec W4 step 7). Rendered SERVER-SIDE with
 * @react-pdf/renderer at check-in completion, stored at contracts/{bookingId}.pdf
 * and attached to the pickup email. Built-in Helvetica only (no font fetches,
 * CSP-irrelevant server-side, deterministic output). Brand accents follow the
 * email templates (#2348c7 ink-blue, #f15f2c pop).
 */
import { Document, Page, Text, View, Image, StyleSheet, renderToBuffer } from "@react-pdf/renderer";

export interface ContractLine { label: string; amount: string }

export interface ContractData {
  operatorName: string;
  contractRef: string;
  generatedAt: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  driverName: string;
  licenseCountry: string;
  vehicleName: string;
  vehiclePlate: string;
  vehicleClass: string;
  periodStart: string;
  periodEnd: string;
  lines: ContractLine[];
  totalAmount: string;
  paidAmount: string;
  balanceDue: string;
  borgLine: string;
  policyVersion: number;
  policyText: string;
  signaturePngDataUrl: string | null;
  photoCount: number;
  odometer: string;
  fuel: string;
}

const BRAND = "#2348c7";
const INK = "#15192f";
const MUTED = "#828aa6";

const s = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: "Helvetica", color: INK },
  brand: { fontSize: 16, fontFamily: "Helvetica-Bold", letterSpacing: 1, marginBottom: 2 },
  subtitle: { color: MUTED, marginBottom: 16 },
  h2: { fontSize: 12, fontFamily: "Helvetica-Bold", color: BRAND, marginTop: 14, marginBottom: 6 },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 3 },
  label: { color: MUTED },
  value: { fontFamily: "Helvetica-Bold" },
  divider: { borderBottomWidth: 1, borderBottomColor: "#e3e6f0", marginVertical: 8 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 4, paddingTop: 4, borderTopWidth: 1, borderTopColor: INK },
  policy: { fontSize: 8, color: INK, lineHeight: 1.5, marginTop: 4 },
  signatureBox: { marginTop: 10, borderWidth: 1, borderColor: "#e3e6f0", borderRadius: 4, padding: 8, height: 90 },
  signatureImg: { height: 60, objectFit: "contain", alignSelf: "flex-start" },
  footer: { position: "absolute", bottom: 24, left: 40, right: 40, color: MUTED, fontSize: 8, textAlign: "center" },
});

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.row}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.value}>{value}</Text>
    </View>
  );
}

function ContractDoc({ d }: { d: ContractData }) {
  return (
    <Document title={`Rental contract ${d.contractRef}`} author={d.operatorName}>
      <Page size="A4" style={s.page}>
        <Text style={s.brand}>{d.operatorName.toUpperCase()}</Text>
        <Text style={s.subtitle}>Rental contract {d.contractRef} · generated {d.generatedAt}</Text>

        <Text style={s.h2}>Renter</Text>
        <Fact label="Name" value={d.customerName} />
        <Fact label="Email" value={d.customerEmail} />
        {d.customerPhone ? <Fact label="Phone" value={d.customerPhone} /> : null}
        <Fact label="Driver on licence" value={d.driverName} />
        {d.licenseCountry ? <Fact label="Licence country" value={d.licenseCountry} /> : null}

        <Text style={s.h2}>Vehicle and period</Text>
        <Fact label="Vehicle" value={`${d.vehicleName} (${d.vehicleClass})`} />
        <Fact label="Plate" value={d.vehiclePlate} />
        <Fact label="Pickup" value={d.periodStart} />
        <Fact label="Return" value={d.periodEnd} />
        <Fact label="Odometer at pickup" value={d.odometer || "not recorded"} />
        <Fact label="Fuel at pickup" value={d.fuel || "not recorded"} />
        <Fact label="Condition photos on file" value={String(d.photoCount)} />

        <Text style={s.h2}>Charges</Text>
        {d.lines.map((l) => <Fact key={l.label} label={l.label} value={l.amount} />)}
        <View style={s.totalRow}>
          <Text style={s.value}>Rental total</Text>
          <Text style={s.value}>{d.totalAmount}</Text>
        </View>
        <Fact label="Paid" value={d.paidAmount} />
        <Fact label="Balance due" value={d.balanceDue} />
        <Fact label="Security deposit (borg)" value={d.borgLine} />

        <Text style={s.h2}>Rental terms (version {d.policyVersion})</Text>
        <Text style={s.policy}>{d.policyText}</Text>

        <Text style={s.h2}>Customer signature</Text>
        <View style={s.signatureBox}>
          {d.signaturePngDataUrl
            ? <Image style={s.signatureImg} src={d.signaturePngDataUrl} />
            : <Text style={s.label}>Signed on the staff device</Text>}
          <Text style={{ color: MUTED, marginTop: 6 }}>
            {d.customerName} accepted rental terms version {d.policyVersion} at check-in.
          </Text>
        </View>

        <Text style={s.footer}>{d.operatorName} · contract {d.contractRef}</Text>
      </Page>
    </Document>
  );
}

export async function renderContractPdf(data: ContractData): Promise<Uint8Array> {
  const buffer = await renderToBuffer(<ContractDoc d={data} />);
  return new Uint8Array(buffer);
}
```

- [ ] Run the test to verify it passes:

```bash
npm test -- --no-file-parallelism src/test/pdf-contract.test.ts
```

Expected: 2 tests pass (first render is slow, ~1-3s, that is normal for @react-pdf).

- [ ] Commit:

```bash
git add src/lib/pdf/contract.tsx src/test/pdf-contract.test.ts
git commit -m "feat(pdf): rental contract renderer with signature image and policy text"
```

---

### Task 7: Pickup and return email templates + attachment support

**Files:**
- Modify: `src/lib/email/templates.ts` (append two template functions at the END of the file; plans 02/03 may have appended others before them, that is fine)
- Modify: `src/lib/email/send.ts` (optional attachments passthrough)
- Test: `src/test/checkin-emails.test.ts`

**Interfaces:**
- Consumes: the file's existing private helpers `shell(title, body)` and `money(cents, currency)` (already defined at the top of `templates.ts`), `RenderedEmail { subject: string; html: string }`.
- Produces (seams-doc canonical names):
  - `bookingPickedUpEmail(args: { vehicleName: string; periodStart: string; periodEnd: string; balanceDueCents: number; borgReceivedCents: number | null; currency: string }): RenderedEmail` — the contract PDF rides along as an attachment added by the CALLER via `sendAndLog`.
  - `bookingReturnSummaryEmail(args: { vehicleName: string; returnedAt: string; newDamage: boolean; borgReturnedCents: number | null; borgWithheldCents: number | null; borgWithheldReason: string | null; currency: string }): RenderedEmail`
  - `OutboundEmail` in `send.ts` gains `attachments?: Array<{ filename: string; content: string }>` (base64 payloads), passed straight through to Resend.

**Steps:**

- [ ] Write the failing test `src/test/checkin-emails.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { bookingPickedUpEmail, bookingReturnSummaryEmail } from "@/lib/email/templates";

const pickedUp = bookingPickedUpEmail({
  vehicleName: "Kia Sportage",
  periodStart: "Aug 1, 2026 at 09:00",
  periodEnd: "Aug 5, 2026 at 09:00",
  balanceDueCents: 0,
  borgReceivedCents: 25000,
  currency: "USD",
});

const returnedClean = bookingReturnSummaryEmail({
  vehicleName: "Kia Sportage",
  returnedAt: "Aug 5, 2026 at 09:30",
  newDamage: false,
  borgReturnedCents: 25000,
  borgWithheldCents: 0,
  borgWithheldReason: null,
  currency: "USD",
});

const returnedDamaged = bookingReturnSummaryEmail({
  vehicleName: "Kia Sportage",
  returnedAt: "Aug 5, 2026 at 09:30",
  newDamage: true,
  borgReturnedCents: 15000,
  borgWithheldCents: 10000,
  borgWithheldReason: "scratch on the left door",
  currency: "USD",
});

describe("check-in/out emails", () => {
  it("pickup email mentions the contract attachment and the borg", () => {
    expect(pickedUp.subject).toContain("Kia Sportage");
    expect(pickedUp.html).toContain("attached");
    expect(pickedUp.html).toContain("USD 250.00");
  });

  it("return summary reflects clean vs damaged returns and borg amounts", () => {
    expect(returnedClean.html).toContain("USD 250.00");
    expect(returnedClean.html).not.toContain("withheld");
    expect(returnedDamaged.html).toContain("USD 100.00");
    expect(returnedDamaged.html).toContain("scratch on the left door");
  });

  it("contains no em-dashes (house writing rule)", () => {
    for (const e of [pickedUp, returnedClean, returnedDamaged]) {
      expect(e.subject).not.toContain("—");
      expect(e.html).not.toContain("—");
      expect(e.subject).not.toContain("--");
    }
  });
});
```

- [ ] Run it to verify it fails:

```bash
npm test -- --no-file-parallelism src/test/checkin-emails.test.ts
```

Expected failure: `bookingPickedUpEmail` is not exported.

- [ ] Append to the END of `src/lib/email/templates.ts`:

```ts
export function bookingPickedUpEmail(args: {
  vehicleName: string; periodStart: string; periodEnd: string;
  balanceDueCents: number; borgReceivedCents: number | null; currency: string;
}): RenderedEmail {
  const balanceLine = args.balanceDueCents > 0
    ? `<br>Still open: <strong>${money(args.balanceDueCents, args.currency)}</strong>`
    : "";
  const borgLine = args.borgReceivedCents
    ? `<br>Security deposit received: ${money(args.borgReceivedCents, args.currency)} (refundable at return)`
    : "";
  return {
    subject: `You are on the road: ${args.vehicleName}`,
    html: shell("Enjoy the ride", `
      <p>Your ${args.vehicleName} is checked out and ready. Your signed rental contract is attached to this email.</p>
      <p><strong>${args.vehicleName}</strong><br>${args.periodStart} to ${args.periodEnd}${balanceLine}${borgLine}</p>
      <p>Questions during your rental? Just reply here or message us on WhatsApp.</p>`),
  };
}

export function bookingReturnSummaryEmail(args: {
  vehicleName: string; returnedAt: string; newDamage: boolean;
  borgReturnedCents: number | null; borgWithheldCents: number | null;
  borgWithheldReason: string | null; currency: string;
}): RenderedEmail {
  const damagePara = args.newDamage
    ? `<p>We noted new damage at return and documented it with photos. Our team will be in touch if anything more is needed.</p>`
    : `<p>The car came back in great shape. Thank you for taking care of it.</p>`;
  const borgPara = args.borgReturnedCents !== null || args.borgWithheldCents !== null
    ? `<p>Security deposit: <strong>${money(args.borgReturnedCents ?? 0, args.currency)}</strong> returned${
        args.borgWithheldCents
          ? `, ${money(args.borgWithheldCents, args.currency)} withheld (${args.borgWithheldReason ?? "see notes"})`
          : ""
      }.</p>`
    : "";
  return {
    subject: `Thanks for riding with us: ${args.vehicleName} returned`,
    html: shell("Rental completed", `
      <p>Your ${args.vehicleName} was returned on ${args.returnedAt}.</p>
      ${damagePara}
      ${borgPara}
      <p>We would love to see you again next trip.</p>`),
  };
}
```

- [ ] Add attachment support in `src/lib/email/send.ts`. Change the `OutboundEmail` interface from:

```ts
export interface OutboundEmail {
  to: string;
  type: string; // e.g. "login_code", "booking_confirmed", "admin_new_booking"
  subject: string;
  html: string;
}
```

to:

```ts
export interface OutboundEmail {
  to: string;
  type: string; // e.g. "login_code", "booking_confirmed", "admin_new_booking"
  subject: string;
  html: string;
  /** Optional attachments (base64 content), e.g. the rental contract PDF. */
  attachments?: Array<{ filename: string; content: string }>;
}
```

and change the Resend call from:

```ts
    const { data, error } = await resend.emails.send({
      from: env.EMAIL_FROM,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
    });
```

to:

```ts
    const { data, error } = await resend.emails.send({
      from: env.EMAIL_FROM,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      ...(msg.attachments ? { attachments: msg.attachments } : {}),
    });
```

- [ ] Run the test to verify it passes, plus the neighbours that touch these files:

```bash
npm test -- --no-file-parallelism src/test/checkin-emails.test.ts src/test/email-templates.test.ts src/test/email-send.test.ts
```

Expected: all pass.

- [ ] Commit:

```bash
git add src/lib/email/templates.ts src/lib/email/send.ts src/test/checkin-emails.test.ts
git commit -m "feat(email): pickup and return summary templates, attachment passthrough for contracts"
```

---

### Task 8: completePickup + completeReturn with bells and artifacts

**Files:**
- Modify: `src/lib/admin/inspections.ts` (append the completion slice)
- Test: `src/test/inspection-complete.test.ts`

**Interfaces:**
- Consumes: everything Task 5 defined in the same file; `assertBookingTransition` from `@/lib/booking/transitions`; `renderContractPdf, type ContractData` from `@/lib/pdf/contract` (Task 6); `putObject, getObject` from `@/lib/storage`; `bookingPickedUpEmail, bookingReturnSummaryEmail` from `@/lib/email/templates` and `sendAndLog` from `@/lib/email/send` (Task 7); `notifyAdmin` from `@/lib/notify` (`notifyAdmin({ level, type, title, body, bookingId })`, never throws); `getPolicyVersion` from `@/lib/admin/policies` (`getPolicyVersion("rental_terms", version)`); `formatDateTime` from `@/lib/time/format` (plan 01 seam: `formatDateTime(iso: string): string`); `siteName` from `@/lib/site-config` (plan 02 seam); `logger` from `@/lib/logger`.
- Produces (seams-doc canonical):
  - `completePickup(bookingId: string, opts: { actorId: string; overrideNote?: string }): Promise<BookingRow>` — guards, flips to `picked_up`, then best-effort: bell `booking.picked_up`, contract PDF stored at `contracts/{bookingId}.pdf` + `contractPdfKey` saved, `bookingPickedUpEmail` with the PDF attached.
  - `completeReturn(bookingId: string, opts: { actorId: string }): Promise<BookingRow>` — guards, flips to `completed`, bell `booking.returned` (level `warning` when damage was flagged), `bookingReturnSummaryEmail`.

**Steps:**

- [ ] Write the failing test `src/test/inspection-complete.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, adminUsers, inspections, notifications, policies } from "@/lib/db/schema";
import { upsertInspection, completePickup, completeReturn, REQUIRED_ANGLES } from "@/lib/admin/inspections";
import { putObject, getObject } from "@/lib/storage";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "", adminId = "";
let month = 1;

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function mkBooking(key: string, status: "pending" | "confirmed" | "picked_up") {
  const m = String(month++).padStart(2, "0");
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt: new Date(`2027-${m}-01T13:00:00Z`),
    endAt: new Date(`2027-${m}-05T13:00:00Z`),
    bufferEndAt: new Date(`2027-${m}-06T13:00:00Z`),
    status,
    priceBreakdown: { subtotalCents: 40000, vehicleCents: 40000, insuranceCents: 0, addOns: [], addOnsCents: 0, days: 4, currency: "USD" },
    paymentOption: "deposit", acceptedPolicyVersion: 1, acceptedAt: new Date(),
    idempotencyKey: key,
  }).returning();
  return b!;
}

/** Fill a pickup inspection to completeness (photos, meters, borg, signature). */
async function readyPickup(bookingId: string) {
  const sigKey = `signatures/${bookingId}.png`;
  await putObject(sigKey, new Uint8Array(PNG_1PX), "image/png");
  await upsertInspection(bookingId, "pickup", {
    photos: REQUIRED_ANGLES.map((a) => ({ key: `inspections/${bookingId}/pickup/${a}.jpg`, label: a })),
    odometer: 41250, fuelLevel: 6,
    borgReceivedCents: 25000, borgMethod: "cash",
    licensePhotoKey: `licenses/${bookingId}/x.jpg`, licenseCopyReceived: true,
    rulesSigned: true, agreementSigned: true, acceptedPolicyVersion: 1,
    signatureKey: sigKey,
  }, adminId);
}

async function readyReturn(bookingId: string, damage = false) {
  await upsertInspection(bookingId, "return", {
    photos: REQUIRED_ANGLES.map((a) => ({ key: `inspections/${bookingId}/return/${a}.jpg`, label: a })),
    odometer: 41600, fuelLevel: 6, keysReturned: true,
    damageFlags: damage ? [{ photoKey: `inspections/${bookingId}/return/front.jpg`, note: "new scratch front bumper" }] : [],
    borgReturnedCents: damage ? 15000 : 25000,
    borgWithheldCents: damage ? 10000 : 0,
    borgWithheldReason: damage ? "scratch on the front bumper" : null,
  }, adminId);
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "insp-done-car", plate: "PL-insp-done", class: "SUV", name: "Done Car", seats: 5,
    transmission: "Automatic", doors: 5, priceDayCents: 10000, priceWeekCents: 60000,
    priceMonthCents: 200000, depositCents: 25000,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "insp-done@test.com" }).returning();
  const [a] = await db.insert(adminUsers).values({ email: "insp-done-admin@test.com", passwordHash: "x" }).returning();
  await db.insert(policies).values({ type: "rental_terms", version: 1, body: "Drive nicely.", publishedAt: new Date() });
  vehicleId = v!.id; customerId = c!.id; adminId = a!.id;
});

afterAll(async () => {
  await rm(path.resolve(process.cwd(), ".dev-storage"), { recursive: true, force: true });
});

describe("completePickup", () => {
  it("flips confirmed -> picked_up, stores the contract, and rings the bell", async () => {
    const b = await mkBooking("done-pickup-1", "confirmed");
    await readyPickup(b.id);
    const updated = await completePickup(b.id, { actorId: adminId });
    expect(updated.status).toBe("picked_up");

    const [insp] = await db.select().from(inspections)
      .where(and(eq(inspections.bookingId, b.id), eq(inspections.kind, "pickup")));
    expect(insp!.contractPdfKey).toBe(`contracts/${b.id}.pdf`);
    const pdf = await getObject(`contracts/${b.id}.pdf`);
    expect(Buffer.from(pdf.data.slice(0, 5)).toString("ascii")).toBe("%PDF-");

    const bells = await db.select().from(notifications).where(eq(notifications.bookingId, b.id));
    expect(bells.some((n) => n.type === "booking.picked_up")).toBe(true);
  });

  it("refuses an incomplete inspection (missing angles)", async () => {
    const b = await mkBooking("done-pickup-2", "confirmed");
    await upsertInspection(b.id, "pickup", { odometer: 1, fuelLevel: 4 }, adminId);
    await expect(completePickup(b.id, { actorId: adminId })).rejects.toThrow(/walk-around photos/i);
  });

  it("requires a desk override note for an unpaid (pending) booking, then records it", async () => {
    const b = await mkBooking("done-pickup-3", "pending");
    await readyPickup(b.id);
    await expect(completePickup(b.id, { actorId: adminId })).rejects.toThrow(/override note/i);
    const updated = await completePickup(b.id, { actorId: adminId, overrideNote: "owner said ok, pays cash later" });
    expect(updated.status).toBe("picked_up");
    expect(updated.notes).toContain("owner said ok");
  });

  it("cannot complete twice", async () => {
    const b = await mkBooking("done-pickup-4", "confirmed");
    await readyPickup(b.id);
    await completePickup(b.id, { actorId: adminId });
    await expect(completePickup(b.id, { actorId: adminId })).rejects.toThrow(/cannot move/i);
  });
});

describe("completeReturn", () => {
  it("flips picked_up -> completed and rings a WARNING bell on damage", async () => {
    const b = await mkBooking("done-return-1", "confirmed");
    await readyPickup(b.id);
    await completePickup(b.id, { actorId: adminId });
    await readyReturn(b.id, true);
    const updated = await completeReturn(b.id, { actorId: adminId });
    expect(updated.status).toBe("completed");
    const bells = await db.select().from(notifications).where(eq(notifications.bookingId, b.id));
    const returned = bells.find((n) => n.type === "booking.returned");
    expect(returned?.level).toBe("warning");
  });

  it("only a picked_up booking can be returned", async () => {
    const b = await mkBooking("done-return-2", "confirmed");
    await expect(completeReturn(b.id, { actorId: adminId })).rejects.toThrow(/cannot move/i);
  });

  it("borg math must add up and withholding needs a reason", async () => {
    const b = await mkBooking("done-return-3", "confirmed");
    await readyPickup(b.id);
    await completePickup(b.id, { actorId: adminId });
    await upsertInspection(b.id, "return", {
      photos: REQUIRED_ANGLES.map((a) => ({ key: `inspections/${b.id}/return/${a}.jpg`, label: a })),
      odometer: 41600, fuelLevel: 6, keysReturned: true,
      borgReturnedCents: 10000, borgWithheldCents: 10000, // received was 25000
    }, adminId);
    await expect(completeReturn(b.id, { actorId: adminId })).rejects.toThrow(/add up/i);
    await upsertInspection(b.id, "return", { borgReturnedCents: 15000, borgWithheldCents: 10000 }, adminId);
    await expect(completeReturn(b.id, { actorId: adminId })).rejects.toThrow(/reason/i);
    await upsertInspection(b.id, "return", { borgWithheldReason: "missing hubcap" }, adminId);
    const updated = await completeReturn(b.id, { actorId: adminId });
    expect(updated.status).toBe("completed");
  });
});
```

- [ ] Run it to verify it fails:

```bash
npm test -- --no-file-parallelism src/test/inspection-complete.test.ts
```

Expected failure: `completePickup` is not exported from `@/lib/admin/inspections`.

- [ ] Append the completion slice to `src/lib/admin/inspections.ts`. Add these imports at the top of the file (merge into the existing import lines):

```ts
import { assertBookingTransition } from "@/lib/booking/transitions";
import { renderContractPdf } from "@/lib/pdf/contract";
import { putObject, getObject } from "@/lib/storage";
import { bookingPickedUpEmail, bookingReturnSummaryEmail } from "@/lib/email/templates";
import { sendAndLog } from "@/lib/email/send";
import { notifyAdmin } from "@/lib/notify";
import { getPolicyVersion } from "@/lib/admin/policies";
import { formatDateTime } from "@/lib/time/format";
import { siteName } from "@/lib/site-config";
import { logger } from "@/lib/logger";
```

then append at the END of the file:

```ts
function assertAnglesPresent(insp: Inspection, what: string): void {
  const labels = new Set(insp.photos.map((p) => p.label));
  const missing = REQUIRED_ANGLES.filter((a) => !labels.has(a));
  if (missing.length > 0) throw Errors.badRequest(`${what} still needed: ${missing.join(", ")}`);
}

/**
 * Finish check-in: guard the inspection completeness inside a transaction,
 * flip the booking to picked_up, then (best-effort, AFTER commit) generate the
 * contract PDF, store it, and email it. A contract hiccup never un-picks-up
 * the car; it is flagged on the bell instead.
 */
export async function completePickup(
  bookingId: string,
  opts: { actorId: string; overrideNote?: string },
): Promise<BookingRow> {
  const db = await getDb();
  const flipped = await db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
    if (!booking) throw Errors.notFound("Booking not found");
    if (booking.status === "pending" && !opts.overrideNote?.trim()) {
      throw Errors.badRequest("This booking is not paid yet. Add a desk override note to check it out anyway.");
    }
    assertBookingTransition(booking.status, "picked_up");

    const [insp] = await tx.select().from(inspections)
      .where(and(eq(inspections.bookingId, bookingId), eq(inspections.kind, "pickup")));
    if (!insp) throw Errors.badRequest("Start the check-in wizard first");
    assertAnglesPresent(insp, "Walk-around photos");
    if (insp.odometer === null || insp.fuelLevel === null) {
      throw Errors.badRequest("Record the odometer and fuel level first");
    }
    if (!insp.rulesSigned || !insp.agreementSigned || !insp.signatureKey) {
      throw Errors.badRequest("The customer still needs to read the rules and sign");
    }

    const notes = booking.status === "pending" && opts.overrideNote
      ? [booking.notes, `Desk override at check-in: ${opts.overrideNote.trim()}`].filter(Boolean).join("\n")
      : booking.notes;
    const [updated] = await tx.update(bookings)
      .set({ status: "picked_up", notes, updatedAt: new Date() })
      .where(eq(bookings.id, bookingId))
      .returning();
    return { booking: updated!, inspection: insp };
  });

  const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, flipped.booking.vehicleId));
  const [customer] = await db.select().from(customers).where(eq(customers.id, flipped.booking.customerId));
  await notifyAdmin({
    level: "success", type: "booking.picked_up", title: "Customer picked up",
    body: `${vehicle?.name ?? "Vehicle"} · ${customer?.email ?? ""}`, bookingId,
  });
  try {
    await finalizePickupArtifacts(flipped.booking, flipped.inspection);
  } catch (e) {
    logger.error("checkin_artifacts_failed", { bookingId, error: (e as Error).message });
    await notifyAdmin({
      level: "warning", type: "booking.picked_up", title: "Contract generation failed",
      body: "Check-in completed but the contract PDF or email failed. Check the server logs.", bookingId,
    });
  }
  return flipped.booking;
}

/** Contract PDF + storage + customer email. Called best-effort after the status flip. */
async function finalizePickupArtifacts(booking: BookingRow, insp: Inspection): Promise<void> {
  const db = await getDb();
  const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, booking.vehicleId));
  const [customer] = await db.select().from(customers).where(eq(customers.id, booking.customerId));
  if (!vehicle || !customer) throw new Error("booking context missing");
  const [license] = await db.select().from(driverLicenses).where(eq(driverLicenses.bookingId, booking.id));
  const policy = (insp.acceptedPolicyVersion !== null
    ? await getPolicyVersion("rental_terms", insp.acceptedPolicyVersion)
    : undefined) ?? await getLatestPolicy("rental_terms");

  const breakdown = booking.priceBreakdown as Partial<QuoteBreakdown> & { youngDriverCents?: number };
  const currency = breakdown.currency ?? "USD";
  const subtotal = breakdown.subtotalCents ?? 0;
  const balance = Math.max(0, subtotal - booking.amountPaidCents);

  let signaturePngDataUrl: string | null = null;
  if (insp.signatureKey) {
    try {
      const sig = await getObject(insp.signatureKey);
      signaturePngDataUrl = `data:image/png;base64,${Buffer.from(sig.data).toString("base64")}`;
    } catch (e) {
      logger.warn("checkin_signature_read_failed", { bookingId: booking.id, error: (e as Error).message });
    }
  }

  const pdf = await renderContractPdf({
    operatorName: siteName,
    contractRef: booking.id.slice(0, 8).toUpperCase(),
    generatedAt: formatDateTime(new Date().toISOString()),
    customerName: customer.name ?? license?.nameOnLicense ?? customer.email,
    customerEmail: customer.email,
    customerPhone: customer.phone ?? "",
    driverName: license?.nameOnLicense ?? "On file at the desk",
    licenseCountry: license?.issuingCountry ?? "",
    vehicleName: vehicle.name,
    vehiclePlate: vehicle.plate,
    vehicleClass: vehicle.class,
    periodStart: formatDateTime(booking.startAt.toISOString()),
    periodEnd: formatDateTime(booking.endAt.toISOString()),
    lines: [
      { label: breakdown.days ? `Vehicle (${breakdown.days} days)` : "Vehicle", amount: money(breakdown.vehicleCents ?? subtotal, currency) },
      ...(breakdown.insuranceCents ? [{ label: "Insurance", amount: money(breakdown.insuranceCents, currency) }] : []),
      ...(breakdown.addOns ?? []).map((a) => ({ label: `${a.name} x${a.qty}`, amount: money(a.cents, currency) })),
      ...(breakdown.youngDriverCents ? [{ label: "Young driver fee", amount: money(breakdown.youngDriverCents, currency) }] : []),
    ],
    totalAmount: money(subtotal, currency),
    paidAmount: money(booking.amountPaidCents, currency),
    balanceDue: money(balance, currency),
    borgLine: insp.borgReceivedCents !== null
      ? `${money(insp.borgReceivedCents, currency)} received in ${insp.borgMethod === "card" ? "card" : "cash"} (refundable at return)`
      : "No security deposit collected",
    policyVersion: policy?.version ?? 0,
    policyText: policy?.body ?? "",
    signaturePngDataUrl,
    photoCount: insp.photos.length,
    odometer: insp.odometer === null ? "" : String(insp.odometer),
    fuel: fuelEighthsLabel(insp.fuelLevel),
  });

  const key = `contracts/${booking.id}.pdf`;
  await putObject(key, pdf, "application/pdf");
  await db.update(inspections).set({ contractPdfKey: key }).where(eq(inspections.id, insp.id));

  await sendAndLog({
    to: customer.email,
    type: "booking_picked_up",
    ...bookingPickedUpEmail({
      vehicleName: vehicle.name,
      periodStart: formatDateTime(booking.startAt.toISOString()),
      periodEnd: formatDateTime(booking.endAt.toISOString()),
      balanceDueCents: balance,
      borgReceivedCents: insp.borgReceivedCents,
      currency,
    }),
    attachments: [{ filename: "rental-contract.pdf", content: Buffer.from(pdf).toString("base64") }],
  });
}

/**
 * Finish check-out: guard the return inspection (angles, meters, damage notes,
 * borg math, keys), flip to completed, then bell + summary email. Damage makes
 * the bell a WARNING so the owner sees it without opening anything.
 */
export async function completeReturn(
  bookingId: string,
  opts: { actorId: string },
): Promise<BookingRow> {
  void opts;
  const db = await getDb();
  const done = await db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
    if (!booking) throw Errors.notFound("Booking not found");
    assertBookingTransition(booking.status, "completed");

    const rows = await tx.select().from(inspections).where(eq(inspections.bookingId, bookingId));
    const pickup = rows.find((i) => i.kind === "pickup") ?? null;
    const ret = rows.find((i) => i.kind === "return");
    if (!ret) throw Errors.badRequest("Start the check-out wizard first");
    assertAnglesPresent(ret, "Return photos");
    if (ret.odometer === null || ret.fuelLevel === null) {
      throw Errors.badRequest("Record the odometer and fuel level first");
    }
    for (const flag of ret.damageFlags) {
      if (!flag.note.trim()) throw Errors.badRequest("Every new damage flag needs a note");
    }
    if (!ret.keysReturned) throw Errors.badRequest("Mark the keys as returned first");

    const received = pickup?.borgReceivedCents ?? null;
    if (received !== null) {
      if (ret.borgReturnedCents === null || ret.borgWithheldCents === null) {
        throw Errors.badRequest("Record the borg decision first: returned in full, partial, or withheld");
      }
      if (ret.borgReturnedCents + ret.borgWithheldCents !== received) {
        throw Errors.badRequest("Borg returned plus withheld must add up to the amount received");
      }
      if (ret.borgWithheldCents > 0 && !ret.borgWithheldReason?.trim()) {
        throw Errors.badRequest("A reason is required when any part of the borg is withheld");
      }
    }

    const [updated] = await tx.update(bookings)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(bookings.id, bookingId))
      .returning();
    return { booking: updated!, inspection: ret };
  });

  const damage = done.inspection.damageFlags.length > 0;
  const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, done.booking.vehicleId));
  const [customer] = await db.select().from(customers).where(eq(customers.id, done.booking.customerId));
  await notifyAdmin({
    level: damage ? "warning" : "success",
    type: "booking.returned",
    title: damage ? "Car returned with new damage" : "Car returned",
    body: `${vehicle?.name ?? "Vehicle"} · ${customer?.email ?? ""}${damage ? ` · ${done.inspection.damageFlags.length} damage flag(s)` : ""}`,
    bookingId,
  });
  if (customer) {
    const breakdown = done.booking.priceBreakdown as { currency?: string };
    await sendAndLog({
      to: customer.email,
      type: "booking_return_summary",
      ...bookingReturnSummaryEmail({
        vehicleName: vehicle?.name ?? "your rental car",
        returnedAt: formatDateTime(new Date().toISOString()),
        newDamage: damage,
        borgReturnedCents: done.inspection.borgReturnedCents,
        borgWithheldCents: done.inspection.borgWithheldCents,
        borgWithheldReason: done.inspection.borgWithheldReason,
        currency: breakdown.currency ?? "USD",
      }),
    });
  }
  return done.booking;
}
```

- [ ] Run the test to verify it passes:

```bash
npm test -- --no-file-parallelism src/test/inspection-complete.test.ts
```

Expected: all tests pass (the contract render adds a couple of seconds).

- [ ] Run the full suite:

```bash
npm test -- --no-file-parallelism
```

- [ ] Commit:

```bash
git add src/lib/admin/inspections.ts src/test/inspection-complete.test.ts
git commit -m "feat(inspections): complete pickup/return with contract PDF, bells, and summary emails"
```

---

### Task 9: Inspection API routes + apiPut client helper

**Files:**
- Create: `src/app/api/admin/bookings/[id]/handover/route.ts`
- Create: `src/app/api/admin/bookings/[id]/inspection/[kind]/route.ts`
- Create: `src/app/api/admin/bookings/[id]/inspection/[kind]/complete/route.ts`
- Create: `src/app/api/admin/bookings/[id]/desk-payment/route.ts`
- Modify: `src/app/admin/client.ts` (add PUT support)
- Test: (route handlers are thin wrappers over the Task 5/8 lib functions already under test; gate is typecheck + lint + the manual wizard verification in Tasks 11/12)

**Interfaces:**
- Consumes: `getHandover`, `upsertInspection`, `InspectionPatchSchema`, `recordDeskBalancePayment`, `completePickup`, `completeReturn` from `@/lib/admin/inspections`; `withRoute`, `json`, `parseParams`, `parseJsonBody`, `read`, `mutate`.
- Produces (seams-doc canonical):
  - `GET /api/admin/bookings/[id]/handover` → `HandoverPayload` (Task 5 shape)
  - `PUT /api/admin/bookings/[id]/inspection/[kind]` body = `InspectionPatchSchema` → the updated inspection row. Audit `admin.inspection_updated` (every single-tap checklist toggle is one PUT, therefore one audit entry with before/after — the spec's "audit per toggle").
  - `POST /api/admin/bookings/[id]/inspection/[kind]/complete` body `{ overrideNote?: string }` → `{ id, status }`. Audit `admin.checkin_completed` (pickup) / `admin.checkout_completed` (return).
  - `POST /api/admin/bookings/[id]/desk-payment` body `{ amountCents: number }` → `{ id, amountPaidCents }`. Audit `admin.desk_payment_recorded`.
  - `apiPut<T>(path, body?)` exported from `@/app/admin/client`.

**Steps:**

- [ ] Create `src/app/api/admin/bookings/[id]/handover/route.ts`:

```ts
import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { read } from "@/lib/admin/guard";
import { getHandover } from "@/lib/admin/inspections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const GET = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  return json(await read(req, () => getHandover(id)), req);
});
```

- [ ] Create `src/app/api/admin/bookings/[id]/inspection/[kind]/route.ts`:

```ts
import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams, parseJsonBody } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { upsertInspection, InspectionPatchSchema } from "@/lib/admin/inspections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid(), kind: z.enum(["pickup", "return"]) });

/** Upsert draft inspection fields. One request per checklist toggle = one audit entry. */
export const PUT = withRoute(async (req, { params }) => {
  const { id, kind } = parseParams(await params, ParamsSchema);
  const patch = await parseJsonBody(req, InspectionPatchSchema);
  const updated = await mutate(req, "admin.inspection_updated", async (ctx) => {
    const { before, after } = await upsertInspection(id, kind, patch, ctx.admin.id);
    return { result: after, entity: "inspection", entityId: after.id, before, after };
  });
  return json(updated, req);
});
```

- [ ] Create `src/app/api/admin/bookings/[id]/inspection/[kind]/complete/route.ts`:

```ts
import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams, parseJsonBody } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { completePickup, completeReturn } from "@/lib/admin/inspections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid(), kind: z.enum(["pickup", "return"]) });
const BodySchema = z.object({ overrideNote: z.string().trim().min(3).max(500).optional() }).strict();

export const POST = withRoute(async (req, { params }) => {
  const { id, kind } = parseParams(await params, ParamsSchema);
  const body = await parseJsonBody(req, BodySchema);
  const action = kind === "pickup" ? "admin.checkin_completed" : "admin.checkout_completed";
  const updated = await mutate(req, action, async (ctx) => {
    const row = kind === "pickup"
      ? await completePickup(id, { actorId: ctx.admin.id, overrideNote: body.overrideNote })
      : await completeReturn(id, { actorId: ctx.admin.id });
    return { result: row, entity: "booking", entityId: id, after: { status: row.status } };
  });
  return json({ id: updated.id, status: updated.status }, req);
});
```

- [ ] Create `src/app/api/admin/bookings/[id]/desk-payment/route.ts`:

```ts
import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams, parseJsonBody } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { recordDeskBalancePayment } from "@/lib/admin/inspections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
const BodySchema = z.object({ amountCents: z.number().int().min(1).max(5_000_000) }).strict();

export const POST = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const { amountCents } = await parseJsonBody(req, BodySchema);
  const updated = await mutate(req, "admin.desk_payment_recorded", async (ctx) => {
    const row = await recordDeskBalancePayment(id, amountCents, ctx.admin.id);
    return { result: row, entity: "booking", entityId: id, after: { amountCents, amountPaidCents: row.amountPaidCents } };
  });
  return json({ id: updated.id, amountPaidCents: updated.amountPaidCents }, req);
});
```

- [ ] Add PUT to `src/app/admin/client.ts`. Change:

```ts
type Method = "GET" | "POST" | "PATCH" | "DELETE";
```

to:

```ts
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
```

and after the existing `export const apiPatch = ...` line add:

```ts
export const apiPut = <T>(path: string, body?: unknown) => request<T>("PUT", path, body);
```

(If a previous wave plan already added `apiPut`, skip both edits.)

- [ ] Typecheck and lint:

```bash
npx tsc --noEmit && npm run lint
```

- [ ] Commit:

```bash
git add "src/app/api/admin/bookings/[id]/handover" "src/app/api/admin/bookings/[id]/inspection" "src/app/api/admin/bookings/[id]/desk-payment" src/app/admin/client.ts
git commit -m "feat(api): handover read, inspection upsert/complete, desk payment routes"
```

---

### Task 10: Wizard shared UI kit (photos, signature, fuel, uploads)

**Files:**
- Create: `src/app/admin/(shell)/inspect/wizard-ui.tsx`
- Create: `src/app/admin/(shell)/inspect/inspect.css`
- Test: none (client-only components; gate is typecheck + lint, exercised manually in Tasks 11/12)

**Interfaces:**
- Consumes: `getCsrfToken` from `@/app/admin/client`; `POST /api/admin/uploads` (Task 4); `GET /api/admin/files/{key}` (Task 2).
- Produces (Tasks 11, 12, 13 import ALL of these from `./wizard-ui` / `../inspect/wizard-ui`):
  - `ANGLES: readonly { id: "front"|"back"|"left"|"right"|"interior"|"dash"; label: string }[]`
  - `fileUrl(key: string): string` → `/api/admin/files/{key}`
  - `downscaleImage(file: File, maxEdge?: number): Promise<Blob>` (canvas, longest edge 1600px, JPEG 0.85)
  - `uploadBlob(blob: Blob, opts: { category: "inspection"|"license"|"signature"; bookingId: string; kind?: "pickup"|"return"; label?: string }): Promise<string>` (returns the storage key)
  - `capturePhoto(file: File, opts): Promise<string>` (downscale then upload)
  - `PhotoCapture({ label, photoKey, onFile })` — camera-capture button + thumbnail
  - `FuelSelector({ value, onChange })` and `FUEL_LABELS`
  - `SignatureCanvas({ onBlob })` — hand-rolled pointer-events canvas → PNG blob
  - `StepShell({ step, total, title, children, onBack, onNext, nextLabel, nextDisabled })`
  - Client mirrors of the server payloads: `InspectionDto`, `Handover` (exact copies of Task 5's `Inspection` row shape + `HandoverPayload`, listed below)

**Steps:**

- [ ] Create `src/app/admin/(shell)/inspect/inspect.css`:

```css
/* Check-in / check-out wizard (mobile-first, Sand & Surf admin kit accents). */
.wiz-page { max-width: 640px; margin: 0 auto; padding: 12px 12px 96px; }
.wiz-page h1 { font-size: 20px; margin: 8px 0 2px; }
.wiz-sub { color: var(--muted, #828aa6); font-size: 13px; margin: 0 0 12px; }
.wiz-step { display: flex; flex-direction: column; gap: 12px; }
.wiz-head h2 { font-size: 17px; margin: 2px 0 0; }
.wiz-count { color: var(--muted, #828aa6); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin: 0; }
.wiz-body { display: flex; flex-direction: column; gap: 12px; }
.wiz-footer { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px; }
.wiz-btn { min-height: 48px; padding: 0 18px; border-radius: 10px; border: 1px solid #d7dbe8; background: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
.wiz-btn.primary { background: #2348c7; border-color: #2348c7; color: #fff; }
.wiz-btn.primary:disabled { opacity: .45; cursor: not-allowed; }
.wiz-btn.ghost { background: transparent; }
.wiz-btn.danger { border-color: #c0392b; color: #c0392b; }
.wiz-card { border: 1px solid #e3e6f0; border-radius: 12px; padding: 12px; background: #fff; }
.wiz-row { display: flex; justify-content: space-between; gap: 8px; padding: 4px 0; font-size: 14px; }
.wiz-row .muted { color: var(--muted, #828aa6); }
.wiz-photo { display: flex; flex-direction: column; gap: 8px; }
.wiz-photo img { width: 100%; max-height: 220px; object-fit: cover; border-radius: 10px; border: 1px solid #e3e6f0; }
.wiz-photo-empty { display: flex; align-items: center; justify-content: center; height: 120px; border: 1px dashed #c9cede; border-radius: 10px; color: var(--muted, #828aa6); font-size: 13px; }
.wiz-error { color: #c0392b; font-size: 13px; margin: 0; }
.wiz-fuel { display: flex; gap: 4px; flex-wrap: wrap; }
.wiz-fuel button { min-width: 44px; min-height: 44px; border-radius: 8px; border: 1px solid #d7dbe8; background: #fff; font-weight: 600; cursor: pointer; }
.wiz-fuel button.on { background: #2348c7; border-color: #2348c7; color: #fff; }
.wiz-sig { width: 100%; height: 180px; border: 1px solid #d7dbe8; border-radius: 10px; background: #fff; touch-action: none; display: block; }
.wiz-policy { max-height: 260px; overflow-y: auto; white-space: pre-wrap; font-size: 13px; line-height: 1.6; border: 1px solid #e3e6f0; border-radius: 10px; padding: 12px; background: #fafbfe; }
.wiz-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.wiz-compare figure { margin: 0; }
.wiz-compare figcaption { font-size: 12px; color: var(--muted, #828aa6); margin-bottom: 4px; }
.wiz-compare img { width: 100%; height: 140px; object-fit: cover; border-radius: 8px; border: 1px solid #e3e6f0; }
.wiz-input { min-height: 48px; border: 1px solid #d7dbe8; border-radius: 10px; padding: 0 12px; font-size: 16px; width: 100%; }
textarea.wiz-input { min-height: 72px; padding: 10px 12px; }
.wiz-choice { display: flex; gap: 8px; flex-wrap: wrap; }
.wiz-choice button { flex: 1 1 30%; min-height: 48px; border-radius: 10px; border: 1px solid #d7dbe8; background: #fff; font-weight: 600; cursor: pointer; }
.wiz-choice button.on { background: #2348c7; border-color: #2348c7; color: #fff; }
.wiz-check { display: flex; align-items: center; justify-content: space-between; min-height: 48px; padding: 0 4px; }
.wiz-check .state { font-weight: 700; }
.wiz-check .state.ok { color: #1d7a4f; }
.wiz-check .state.todo { color: #c0392b; }
```

- [ ] Create `src/app/admin/(shell)/inspect/wizard-ui.tsx`:

```tsx
"use client";

/**
 * Shared building blocks for the check-in / check-out wizards (spec W4).
 * Mobile-first: big tap targets, camera capture, and a HAND-ROLLED signature
 * canvas (pointer events -> PNG, CSP-safe, zero dependencies). All media
 * renders through the same-origin /api/admin/files route because the strict
 * admin CSP (img-src 'self') forbids cross-origin storage URLs.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { getCsrfToken } from "@/app/admin/client";
import "./inspect.css";

export const ANGLES = [
  { id: "front", label: "Front" },
  { id: "back", label: "Back" },
  { id: "left", label: "Left side" },
  { id: "right", label: "Right side" },
  { id: "interior", label: "Interior" },
  { id: "dash", label: "Dash and odometer" },
] as const;

export type AngleId = (typeof ANGLES)[number]["id"];

export const fileUrl = (key: string) => `/api/admin/files/${key}`;

/* ---------- client mirrors of the server payloads (Task 5 shapes) ---------- */

export interface InspectionDto {
  id: string;
  kind: "pickup" | "return";
  odometer: number | null;
  fuelLevel: number | null;
  notes: string;
  photos: { key: string; label: string }[];
  licensePhotoKey: string | null;
  signatureKey: string | null;
  contractPdfKey: string | null;
  damageFlags: { photoKey: string; note: string }[];
  acceptedPolicyVersion: number | null;
  agreementSigned: boolean;
  rulesSigned: boolean;
  licenseCopyReceived: boolean;
  borgReceivedCents: number | null;
  borgMethod: string | null;
  borgReturnedCents: number | null;
  borgWithheldCents: number | null;
  borgWithheldReason: string | null;
  keysReturned: boolean;
}

export interface Handover {
  booking: {
    id: string; status: string; source: string; notes: string | null;
    startAt: string; endAt: string; currency: string;
    subtotalCents: number; amountPaidCents: number; balanceDueCents: number;
    priceLines: { label: string; cents: number }[];
  };
  vehicle: { id: string; name: string; plate: string; class: string; depositCents: number | null };
  customer: { name: string | null; email: string; phone: string | null };
  license: { nameOnLicense: string; issuingCountry: string; expiryDate: string } | null;
  policy: { version: number; body: string } | null;
  inspections: { pickup: InspectionDto | null; return: InspectionDto | null };
}

export const money = (cents: number, currency: string) => `${currency} ${(cents / 100).toFixed(2)}`;

/* ------------------------------- uploading -------------------------------- */

/** Canvas downscale: longest edge maxEdge px, JPEG q0.85 (spec W4 storage layer). */
export async function downscaleImage(file: File, maxEdge = 1600): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d");
    if (!g) return file;
    g.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    return file; // un-decodable input: let the server-side type/size caps decide
  }
}

export interface UploadOpts {
  category: "inspection" | "license" | "signature";
  bookingId: string;
  kind?: "pickup" | "return";
  label?: string;
}

/** Multipart POST to /api/admin/uploads. Returns the storage key. */
export async function uploadBlob(blob: Blob, opts: UploadOpts): Promise<string> {
  const form = new FormData();
  form.append("file", blob, opts.category === "signature" ? "signature.png" : "photo.jpg");
  form.append("category", opts.category);
  form.append("bookingId", opts.bookingId);
  if (opts.kind) form.append("kind", opts.kind);
  if (opts.label) form.append("label", opts.label);
  const res = await fetch("/api/admin/uploads", {
    method: "POST",
    headers: { "X-CSRF-Token": getCsrfToken() }, // no Content-Type: the browser sets the multipart boundary
    body: form,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(data?.error?.message ?? "Upload failed. Please try again.");
  }
  return ((await res.json()) as { key: string }).key;
}

export async function capturePhoto(file: File, opts: UploadOpts): Promise<string> {
  return uploadBlob(await downscaleImage(file), opts);
}

/* ------------------------------- components ------------------------------- */

export function PhotoCapture({ label, photoKey, onFile }: {
  label: string;
  photoKey: string | null;
  onFile: (file: File) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="wiz-photo">
      {photoKey
        ? <img src={fileUrl(photoKey)} alt={label} />
        : <div className="wiz-photo-empty">No {label.toLowerCase()} photo yet</div>}
      <button type="button" className="wiz-btn" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? "Uploading..." : photoKey ? `Retake ${label.toLowerCase()}` : `Take ${label.toLowerCase()} photo`}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // allow re-selecting the same file
          if (!file) return;
          setBusy(true);
          setError("");
          try {
            await onFile(file);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
      {error ? <p className="wiz-error">{error}</p> : null}
    </div>
  );
}

export const FUEL_LABELS = ["E", "1/8", "1/4", "3/8", "1/2", "5/8", "3/4", "7/8", "F"] as const;

export function FuelSelector({ value, onChange }: { value: number | null; onChange: (v: number) => void }) {
  return (
    <div className="wiz-fuel" role="radiogroup" aria-label="Fuel level in eighths">
      {FUEL_LABELS.map((l, i) => (
        <button key={l} type="button" className={value === i ? "on" : ""} aria-pressed={value === i} onClick={() => onChange(i)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** Hand-rolled signature pad: pointer events on a canvas, exported as PNG. */
export function SignatureCanvas({ onBlob }: { onBlob: (blob: Blob | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = Math.round(rect.width * dpr);
    c.height = Math.round(180 * dpr);
    const g = c.getContext("2d");
    if (g) {
      g.scale(dpr, dpr);
      g.lineWidth = 2.5;
      g.lineCap = "round";
      g.lineJoin = "round";
      g.strokeStyle = "#15192f";
    }
  }, []);

  const pos = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const emit = () => canvasRef.current?.toBlob((b) => onBlob(b), "image/png");

  return (
    <div>
      <canvas
        ref={canvasRef}
        className="wiz-sig"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const g = e.currentTarget.getContext("2d");
          if (!g) return;
          drawing.current = true;
          const { x, y } = pos(e);
          g.beginPath();
          g.moveTo(x, y);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const g = e.currentTarget.getContext("2d");
          if (!g) return;
          const { x, y } = pos(e);
          g.lineTo(x, y);
          g.stroke();
          if (!hasInk) setHasInk(true);
        }}
        onPointerUp={() => {
          drawing.current = false;
          emit();
        }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
        <span className="wiz-sub">{hasInk ? "Signature captured" : "Sign above with a finger"}</span>
        <button
          type="button"
          className="wiz-btn ghost"
          onClick={() => {
            const c = canvasRef.current;
            const g = c?.getContext("2d");
            if (c && g) g.clearRect(0, 0, c.width, c.height);
            setHasInk(false);
            onBlob(null);
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

export function StepShell({ step, total, title, children, onBack, onNext, nextLabel, nextDisabled }: {
  step: number;
  total: number;
  title: string;
  children: ReactNode;
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
}) {
  return (
    <section className="wiz-step">
      <header className="wiz-head">
        <p className="wiz-count">Step {step} of {total}</p>
        <h2>{title}</h2>
      </header>
      <div className="wiz-body">{children}</div>
      <footer className="wiz-footer">
        {onBack ? <button type="button" className="wiz-btn ghost" onClick={onBack}>Back</button> : <span />}
        {onNext
          ? <button type="button" className="wiz-btn primary" onClick={onNext} disabled={nextDisabled}>{nextLabel ?? "Next"}</button>
          : null}
      </footer>
    </section>
  );
}
```

- [ ] Typecheck and lint:

```bash
npx tsc --noEmit && npm run lint
```

Note: `next lint` may flag the raw `<img>` tags with `@next/next/no-img-element`. These are authenticated, dynamic, same-origin API images where `next/image` optimization is wrong (it would proxy/optimize private media). If the lint rule fires, add `// eslint-disable-next-line @next/next/no-img-element` above each `<img>` in this file rather than weakening the config.

- [ ] Commit:

```bash
git add "src/app/admin/(shell)/inspect/wizard-ui.tsx" "src/app/admin/(shell)/inspect/inspect.css"
git commit -m "feat(admin): wizard UI kit with camera capture, signature canvas, fuel selector"
```

---

### Task 11: Check-in wizard (7 steps, mobile-first)

**Files:**
- Create: `src/app/admin/(shell)/inspect/[bookingId]/checkin/page.tsx`
- Test: none (client page; gate is typecheck + lint + manual verification below)

**Interfaces:**
- Consumes: everything from `../../wizard-ui` (Task 10); `apiGet, api, apiPut` from `@/app/admin/client` (`api` = POST); `useToast` from `@/app/admin/_ui`; routes from Task 9. The 7 steps are the spec's: 1 verify + balance, 2 licence photo, 3 walk-around, 4 odometer/fuel, 5 borg, 6 rules + signature, 7 finish.
- Produces: page at `/admin/inspect/{bookingId}/checkin` (linked from the drawer's InspectionPanel in Task 13).

**Steps:**

- [ ] Create `src/app/admin/(shell)/inspect/[bookingId]/checkin/page.tsx`:

```tsx
"use client";

/**
 * Check-in wizard (spec W4, 7 steps). Runs on the STAFF device (admin auth);
 * the device is handed to the customer only at step 6 (rules + signature).
 * Every write is a small PUT to the pickup inspection, so an interrupted
 * check-in resumes exactly where it stopped (state lives server-side).
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiGet, api, apiPut, type ApiError } from "@/app/admin/client";
import { useToast } from "@/app/admin/_ui";
import {
  ANGLES, PhotoCapture, FuelSelector, SignatureCanvas, StepShell,
  capturePhoto, uploadBlob, money, fileUrl,
  type Handover, type InspectionDto,
} from "../../wizard-ui";

const TOTAL = 7;

export default function CheckinWizard() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const router = useRouter();
  const toast = useToast();

  const [data, setData] = useState<Handover | null>(null);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);

  // step-local state
  const [driverName, setDriverName] = useState("");
  const [driverLicense, setDriverLicense] = useState("");
  const [odometer, setOdometer] = useState("");
  const [borgAmount, setBorgAmount] = useState("");
  const [borgMethod, setBorgMethod] = useState<"cash" | "card">("cash");
  const [signatureBlob, setSignatureBlob] = useState<Blob | null>(null);
  const [overrideNote, setOverrideNote] = useState("");
  const [damageNote, setDamageNote] = useState("");

  const insp: InspectionDto | null = data?.inspections.pickup ?? null;

  const reload = async () => {
    const h = await apiGet<Handover>(`/api/admin/bookings/${bookingId}/handover`);
    setData(h);
    return h;
  };

  useEffect(() => {
    reload()
      .then((h) => {
        setOdometer(h.inspections.pickup?.odometer?.toString() ?? "");
        setBorgAmount((((h.inspections.pickup?.borgReceivedCents ?? h.vehicle.depositCents) ?? 0) / 100).toFixed(0));
      })
      .catch((e: ApiError) => toast.show({ type: "error", message: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  const put = async (patch: Record<string, unknown>) => {
    await apiPut(`/api/admin/bookings/${bookingId}/inspection/pickup`, patch);
    await reload();
  };

  const guarded = (fn: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError | Error).message ?? "Something went wrong" });
    } finally {
      setBusy(false);
    }
  };

  const setAnglePhoto = (angle: string) => async (file: File) => {
    const key = await capturePhoto(file, { category: "inspection", bookingId, kind: "pickup", label: angle });
    const photos = [...(insp?.photos ?? []).filter((p) => p.label !== angle), { key, label: angle }];
    await put({ photos });
  };

  const anglePhoto = (angle: string) => insp?.photos.find((p) => p.label === angle)?.key ?? null;
  const anglesDone = useMemo(() => ANGLES.every((a) => anglePhoto(a.id)), [insp]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <main className="wiz-page"><p className="wiz-sub">Loading booking...</p></main>;

  const b = data.booking;
  const finished = b.status === "picked_up" || b.status === "completed";

  return (
    <main className="wiz-page">
      <h1>Check in: {data.vehicle.name}</h1>
      <p className="wiz-sub">{data.vehicle.plate} · {data.customer.name ?? data.customer.email}</p>

      {finished ? (
        <div className="wiz-card">
          <p>This booking is already checked in. The record lives in the booking drawer.</p>
          <button type="button" className="wiz-btn primary" onClick={() => router.push("/admin")}>Back to the board</button>
        </div>
      ) : null}

      {!finished && step === 1 ? (
        <StepShell step={1} total={TOTAL} title="Verify booking and balance" onNext={() => setStep(2)}>
          <div className="wiz-card">
            {b.priceLines.map((l) => (
              <div className="wiz-row" key={l.label}><span className="muted">{l.label}</span><span>{money(l.cents, b.currency)}</span></div>
            ))}
            <div className="wiz-row"><span className="muted">Paid</span><span>{money(b.amountPaidCents, b.currency)}</span></div>
            <div className="wiz-row"><strong>Balance due at pickup</strong><strong>{money(b.balanceDueCents, b.currency)}</strong></div>
          </div>
          {b.balanceDueCents > 0 ? (
            <button type="button" className="wiz-btn primary" disabled={busy} onClick={guarded(async () => {
              await api(`/api/admin/bookings/${bookingId}/desk-payment`, { amountCents: b.balanceDueCents });
              await reload();
              toast.show({ type: "success", message: "Balance recorded as collected at the desk" });
            })}>
              Record {money(b.balanceDueCents, b.currency)} collected at desk
            </button>
          ) : (
            <p className="wiz-sub">Nothing due. Fully paid.</p>
          )}
          {data.license ? (
            <div className="wiz-card">
              <div className="wiz-row"><span className="muted">Driver on licence</span><span>{data.license.nameOnLicense}</span></div>
              <div className="wiz-row"><span className="muted">Country</span><span>{data.license.issuingCountry}</span></div>
              <div className="wiz-row"><span className="muted">Valid until</span><span>{data.license.expiryDate}</span></div>
            </div>
          ) : (
            <div className="wiz-card">
              <p className="wiz-sub">Desk booking, no licence on file. Note the driver details (the photo in the next step is the licence copy).</p>
              <input className="wiz-input" placeholder="Driver name" value={driverName} onChange={(e) => setDriverName(e.target.value)} />
              <div style={{ height: 8 }} />
              <input className="wiz-input" placeholder="Licence number" value={driverLicense} onChange={(e) => setDriverLicense(e.target.value)} />
              <div style={{ height: 8 }} />
              <button type="button" className="wiz-btn" disabled={busy || !driverName.trim()} onClick={guarded(async () => {
                await put({ notes: `Driver: ${driverName.trim()}${driverLicense.trim() ? `, licence ${driverLicense.trim()}` : ""}` });
                toast.show({ type: "success", message: "Driver details saved" });
              })}>
                Save driver details
              </button>
            </div>
          )}
        </StepShell>
      ) : null}

      {!finished && step === 2 ? (
        <StepShell step={2} total={TOTAL} title="Licence photo" onBack={() => setStep(1)} onNext={() => setStep(3)} nextDisabled={!insp?.licensePhotoKey}>
          <p className="wiz-sub">Photograph the driver&apos;s licence. It lands in private storage, admin eyes only.</p>
          <PhotoCapture label="Licence" photoKey={insp?.licensePhotoKey ?? null} onFile={async (file) => {
            const key = await capturePhoto(file, { category: "license", bookingId });
            await put({ licensePhotoKey: key, licenseCopyReceived: true });
          }} />
        </StepShell>
      ) : null}

      {!finished && step === 3 ? (
        <StepShell step={3} total={TOTAL} title="Walk-around photos" onBack={() => setStep(2)} onNext={() => setStep(4)} nextDisabled={!anglesDone}>
          <p className="wiz-sub">Six angles, every car, every time. Add close-ups for existing damage.</p>
          {ANGLES.map((a) => (
            <div className="wiz-card" key={a.id}>
              <strong>{a.label}</strong>
              <PhotoCapture label={a.label} photoKey={anglePhoto(a.id)} onFile={setAnglePhoto(a.id)} />
            </div>
          ))}
          <div className="wiz-card">
            <strong>Existing damage close-up (optional)</strong>
            <input className="wiz-input" placeholder="What does the photo show? e.g. scratch rear bumper" value={damageNote} onChange={(e) => setDamageNote(e.target.value)} />
            <div style={{ height: 8 }} />
            <PhotoCapture label="Damage close-up" photoKey={null} onFile={async (file) => {
              const note = damageNote.trim() || "existing damage";
              const key = await capturePhoto(file, { category: "inspection", bookingId, kind: "pickup", label: `damage: ${note}` });
              await put({ photos: [...(insp?.photos ?? []), { key, label: `damage: ${note}` }] });
              setDamageNote("");
            }} />
            {(insp?.photos ?? []).filter((p) => p.label.startsWith("damage:")).map((p) => (
              <div className="wiz-row" key={p.key}><span className="muted">{p.label}</span><span>saved</span></div>
            ))}
          </div>
        </StepShell>
      ) : null}

      {!finished && step === 4 ? (
        <StepShell
          step={4} total={TOTAL} title="Odometer and fuel"
          onBack={() => setStep(3)}
          onNext={guarded(async () => {
            const km = Number(odometer);
            if (!Number.isInteger(km) || km < 0) throw new Error("Enter the odometer reading in whole kilometers");
            if (insp?.fuelLevel === null || insp?.fuelLevel === undefined) throw new Error("Tap the fuel level");
            await put({ odometer: km });
            setStep(5);
          })}
          nextDisabled={busy}
        >
          <input className="wiz-input" inputMode="numeric" placeholder="Odometer (km)" value={odometer} onChange={(e) => setOdometer(e.target.value.replace(/\D/g, ""))} />
          <FuelSelector value={insp?.fuelLevel ?? null} onChange={(v) => guarded(() => put({ fuelLevel: v }))()} />
        </StepShell>
      ) : null}

      {!finished && step === 5 ? (
        <StepShell step={5} total={TOTAL} title="Borg (security deposit)" onBack={() => setStep(4)} onNext={() => setStep(6)}>
          <p className="wiz-sub">Refundable, handed back at return. Record what you received.</p>
          <input className="wiz-input" inputMode="numeric" placeholder={`Amount in ${b.currency}`} value={borgAmount} onChange={(e) => setBorgAmount(e.target.value.replace(/\D/g, ""))} />
          <div className="wiz-choice">
            <button type="button" className={borgMethod === "cash" ? "on" : ""} onClick={() => setBorgMethod("cash")}>Cash</button>
            <button type="button" className={borgMethod === "card" ? "on" : ""} onClick={() => setBorgMethod("card")}>Card</button>
          </div>
          <button type="button" className="wiz-btn primary" disabled={busy || !borgAmount} onClick={guarded(async () => {
            await put({ borgReceivedCents: Number(borgAmount) * 100, borgMethod });
            toast.show({ type: "success", message: "Borg recorded" });
          })}>
            Record borg received
          </button>
          <button type="button" className="wiz-btn ghost" disabled={busy} onClick={guarded(async () => {
            await put({ borgReceivedCents: null, borgMethod: null });
            setStep(6);
          })}>
            No borg for this rental
          </button>
          {insp?.borgReceivedCents ? <p className="wiz-sub">On record: {money(insp.borgReceivedCents, b.currency)} in {insp.borgMethod ?? "cash"}.</p> : null}
        </StepShell>
      ) : null}

      {!finished && step === 6 ? (
        <StepShell step={6} total={TOTAL} title="Rules and signature" onBack={() => setStep(5)} onNext={() => setStep(7)} nextDisabled={!insp?.signatureKey || !insp?.rulesSigned}>
          <p className="wiz-sub">Hand the device to the customer to read and sign.</p>
          <div className="wiz-policy">{data.policy?.body ?? "No rental terms published yet."}</div>
          <button type="button" className="wiz-btn" disabled={busy || insp?.rulesSigned} onClick={guarded(async () => {
            await put({ rulesSigned: true, acceptedPolicyVersion: data.policy?.version ?? 0 });
          })}>
            {insp?.rulesSigned ? "Rules accepted" : "Customer accepts the rules"}
          </button>
          <SignatureCanvas onBlob={setSignatureBlob} />
          <button type="button" className="wiz-btn primary" disabled={busy || !signatureBlob} onClick={guarded(async () => {
            const key = await uploadBlob(signatureBlob!, { category: "signature", bookingId });
            await put({ signatureKey: key, agreementSigned: true });
            toast.show({ type: "success", message: "Signature saved" });
          })}>
            Save signature
          </button>
          {insp?.signatureKey ? <img src={fileUrl(insp.signatureKey)} alt="Saved signature" style={{ maxHeight: 80 }} /> : null}
        </StepShell>
      ) : null}

      {!finished && step === 7 ? (
        <StepShell
          step={7} total={TOTAL} title="Finish check-in"
          onBack={() => setStep(6)}
          onNext={guarded(async () => {
            await api(`/api/admin/bookings/${bookingId}/inspection/pickup/complete`,
              b.status === "pending" ? { overrideNote: overrideNote.trim() } : {});
            toast.show({ type: "success", message: "Checked in. Contract is on its way to the customer." });
            router.push("/admin");
          })}
          nextLabel="Complete check-in"
          nextDisabled={busy || (b.status === "pending" && overrideNote.trim().length < 3)}
        >
          <div className="wiz-card">
            {[
              { label: "Balance settled", ok: b.balanceDueCents === 0 },
              { label: "Licence photo", ok: !!insp?.licensePhotoKey },
              { label: "Six walk-around angles", ok: anglesDone },
              { label: "Odometer and fuel", ok: insp?.odometer !== null && insp?.fuelLevel !== null },
              { label: "Borg recorded", ok: insp?.borgReceivedCents !== null },
              { label: "Rules accepted and signed", ok: !!insp?.rulesSigned && !!insp?.signatureKey },
            ].map((c) => (
              <div className="wiz-check" key={c.label}>
                <span>{c.label}</span>
                <span className={`state ${c.ok ? "ok" : "todo"}`}>{c.ok ? "done" : "open"}</span>
              </div>
            ))}
          </div>
          {b.status === "pending" ? (
            <div className="wiz-card">
              <p className="wiz-sub">This booking is not paid online yet. A desk override note is required to hand the car over anyway.</p>
              <textarea className="wiz-input" placeholder="Why is the car going out unpaid?" value={overrideNote} onChange={(e) => setOverrideNote(e.target.value)} />
            </div>
          ) : null}
          <p className="wiz-sub">Completing marks the booking as picked up, generates the contract PDF, and emails it to {data.customer.email}.</p>
        </StepShell>
      ) : null}
    </main>
  );
}
```

- [ ] Typecheck and lint:

```bash
npx tsc --noEmit && npm run lint
```

(Same `<img>` lint note as Task 10 applies.)

- [ ] Manual verification (a `next dev` server; remember: never `npm run build` while it runs):
  1. `npm run db:migrate && npm run db:seed && npm run dev` (plus `npm run admin:create` if no admin exists yet).
  2. Sign in at `http://localhost:3000/admin` (password + TOTP).
  3. Create a manual booking on the planning board for any car, then open `http://localhost:3000/admin/inspect/<bookingId>/checkin` directly (Task 13 adds the drawer button).
  4. Walk all 7 steps on a desktop browser (file inputs stand in for the camera; any jpg works). Verify: photos appear as thumbnails (served from `/api/admin/files/...`), the fuel buttons stick, the signature draws and saves, and step 7 lists everything "done".
  5. Complete the check-in. Expect: toast, redirect to `/admin`, the bar's status now `picked_up`, a bell entry "Customer picked up", and `contracts/<bookingId>.pdf` downloadable at `http://localhost:3000/api/admin/files/contracts/<bookingId>.pdf`.

- [ ] Commit:

```bash
git add "src/app/admin/(shell)/inspect/[bookingId]/checkin/page.tsx"
git commit -m "feat(admin): mobile-first 7-step check-in wizard with balance collect and signature"
```

---

### Task 12: Check-out wizard (5 steps, side-by-side comparison)

**Files:**
- Create: `src/app/admin/(shell)/inspect/[bookingId]/checkout/page.tsx`
- Test: none (client page; typecheck + lint + manual verification)

**Interfaces:**
- Consumes: same kit as Task 11; writes go to the `return` inspection; completion POSTs `/api/admin/bookings/[id]/inspection/return/complete`.
- Produces: page at `/admin/inspect/{bookingId}/checkout`. Steps per spec W4: 1 return photos side-by-side, 2 damage review (same/new + required notes), 3 odometer/fuel with delta, 4 borg return (full/partial/withheld + keys), 5 finish.

**Steps:**

- [ ] Create `src/app/admin/(shell)/inspect/[bookingId]/checkout/page.tsx`:

```tsx
"use client";

/**
 * Check-out wizard (spec W4, 5 steps). Return photos render SIDE-BY-SIDE with
 * the pickup photo of the same angle so new damage is obvious at a glance.
 * The borg button records returned in full / partial / withheld; a reason is
 * required whenever anything is withheld.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiGet, api, apiPut, type ApiError } from "@/app/admin/client";
import { useToast } from "@/app/admin/_ui";
import {
  ANGLES, PhotoCapture, FuelSelector, StepShell,
  capturePhoto, money, fileUrl, FUEL_LABELS,
  type Handover, type InspectionDto,
} from "../../wizard-ui";

const TOTAL = 5;

type DamageChoice = "same" | "new";

export default function CheckoutWizard() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const router = useRouter();
  const toast = useToast();

  const [data, setData] = useState<Handover | null>(null);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [odometer, setOdometer] = useState("");
  const [choices, setChoices] = useState<Record<string, DamageChoice>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [borgChoice, setBorgChoice] = useState<"full" | "partial" | "withheld" | null>(null);
  const [partialReturned, setPartialReturned] = useState("");
  const [withheldReason, setWithheldReason] = useState("");

  const pickup: InspectionDto | null = data?.inspections.pickup ?? null;
  const ret: InspectionDto | null = data?.inspections.return ?? null;

  const reload = async () => {
    const h = await apiGet<Handover>(`/api/admin/bookings/${bookingId}/handover`);
    setData(h);
    return h;
  };

  useEffect(() => {
    reload()
      .then((h) => setOdometer(h.inspections.return?.odometer?.toString() ?? ""))
      .catch((e: ApiError) => toast.show({ type: "error", message: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  const put = async (patch: Record<string, unknown>) => {
    await apiPut(`/api/admin/bookings/${bookingId}/inspection/return`, patch);
    await reload();
  };

  const guarded = (fn: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError | Error).message ?? "Something went wrong" });
    } finally {
      setBusy(false);
    }
  };

  const pickupPhoto = (angle: string) => pickup?.photos.find((p) => p.label === angle)?.key ?? null;
  const returnPhoto = (angle: string) => ret?.photos.find((p) => p.label === angle)?.key ?? null;
  const anglesDone = useMemo(() => ANGLES.every((a) => returnPhoto(a.id)), [ret]); // eslint-disable-line react-hooks/exhaustive-deps

  const setAnglePhoto = (angle: string) => async (file: File) => {
    const key = await capturePhoto(file, { category: "inspection", bookingId, kind: "return", label: angle });
    const photos = [...(ret?.photos ?? []).filter((p) => p.label !== angle), { key, label: angle }];
    await put({ photos });
  };

  if (!data) return <main className="wiz-page"><p className="wiz-sub">Loading booking...</p></main>;

  const b = data.booking;
  const received = pickup?.borgReceivedCents ?? null;
  const finished = b.status === "completed";
  const newDamageAngles = ANGLES.filter((a) => choices[a.id] === "new");

  return (
    <main className="wiz-page">
      <h1>Check out: {data.vehicle.name}</h1>
      <p className="wiz-sub">{data.vehicle.plate} · {data.customer.name ?? data.customer.email}</p>

      {finished ? (
        <div className="wiz-card">
          <p>This booking is already completed.</p>
          <button type="button" className="wiz-btn primary" onClick={() => router.push("/admin")}>Back to the board</button>
        </div>
      ) : null}

      {!finished && step === 1 ? (
        <StepShell step={1} total={TOTAL} title="Return photos" onNext={() => setStep(2)} nextDisabled={!anglesDone}>
          <p className="wiz-sub">Same six angles. The pickup photo sits on the left for comparison.</p>
          {ANGLES.map((a) => (
            <div className="wiz-card" key={a.id}>
              <strong>{a.label}</strong>
              <div className="wiz-compare">
                <figure>
                  <figcaption>At pickup</figcaption>
                  {pickupPhoto(a.id)
                    ? <img src={fileUrl(pickupPhoto(a.id)!)} alt={`${a.label} at pickup`} />
                    : <div className="wiz-photo-empty">No pickup photo</div>}
                </figure>
                <figure>
                  <figcaption>Now</figcaption>
                  {returnPhoto(a.id)
                    ? <img src={fileUrl(returnPhoto(a.id)!)} alt={`${a.label} at return`} />
                    : <div className="wiz-photo-empty">Not taken yet</div>}
                </figure>
              </div>
              <PhotoCapture label={a.label} photoKey={returnPhoto(a.id)} onFile={setAnglePhoto(a.id)} />
            </div>
          ))}
        </StepShell>
      ) : null}

      {!finished && step === 2 ? (
        <StepShell
          step={2} total={TOTAL} title="Damage review"
          onBack={() => setStep(1)}
          onNext={guarded(async () => {
            if (ANGLES.some((a) => !choices[a.id])) throw new Error("Mark every angle as same or new damage");
            for (const a of newDamageAngles) {
              if (!notes[a.id]?.trim()) throw new Error(`Add a note for the new damage on: ${a.label}`);
            }
            const damageFlags = newDamageAngles.map((a) => ({
              photoKey: returnPhoto(a.id) ?? "",
              note: `${a.label}: ${notes[a.id]!.trim()}`,
            }));
            await put({ damageFlags });
            setStep(3);
          })}
          nextDisabled={busy}
        >
          {ANGLES.map((a) => (
            <div className="wiz-card" key={a.id}>
              <div className="wiz-row"><strong>{a.label}</strong></div>
              <div className="wiz-choice">
                <button type="button" className={choices[a.id] === "same" ? "on" : ""} onClick={() => setChoices({ ...choices, [a.id]: "same" })}>Same as pickup</button>
                <button type="button" className={choices[a.id] === "new" ? "on" : ""} onClick={() => setChoices({ ...choices, [a.id]: "new" })}>New damage</button>
              </div>
              {choices[a.id] === "new" ? (
                <>
                  <div style={{ height: 8 }} />
                  <textarea className="wiz-input" placeholder="Describe the new damage (required)" value={notes[a.id] ?? ""} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} />
                </>
              ) : null}
            </div>
          ))}
        </StepShell>
      ) : null}

      {!finished && step === 3 ? (
        <StepShell
          step={3} total={TOTAL} title="Odometer and fuel"
          onBack={() => setStep(2)}
          onNext={guarded(async () => {
            const km = Number(odometer);
            if (!Number.isInteger(km) || km < 0) throw new Error("Enter the odometer reading in whole kilometers");
            if (ret?.fuelLevel === null || ret?.fuelLevel === undefined) throw new Error("Tap the fuel level");
            await put({ odometer: km });
            setStep(4);
          })}
          nextDisabled={busy}
        >
          <input className="wiz-input" inputMode="numeric" placeholder="Odometer (km)" value={odometer} onChange={(e) => setOdometer(e.target.value.replace(/\D/g, ""))} />
          {pickup?.odometer !== null && pickup?.odometer !== undefined && odometer ? (
            <p className="wiz-sub">Driven this rental: {Math.max(0, Number(odometer) - pickup.odometer)} km</p>
          ) : null}
          <FuelSelector value={ret?.fuelLevel ?? null} onChange={(v) => guarded(() => put({ fuelLevel: v }))()} />
          {pickup?.fuelLevel !== null && pickup?.fuelLevel !== undefined ? (
            <p className="wiz-sub">Fuel at pickup was {FUEL_LABELS[pickup.fuelLevel]}.</p>
          ) : null}
        </StepShell>
      ) : null}

      {!finished && step === 4 ? (
        <StepShell
          step={4} total={TOTAL} title="Borg return and keys"
          onBack={() => setStep(3)}
          onNext={guarded(async () => {
            if (received !== null) {
              if (!borgChoice) throw new Error("Pick a borg outcome first");
              const returned = borgChoice === "full" ? received : borgChoice === "withheld" ? 0 : Number(partialReturned) * 100;
              if (!Number.isInteger(returned) || returned < 0 || returned > received) throw new Error("Returned amount must be between 0 and what was received");
              const withheld = received - returned;
              if (withheld > 0 && !withheldReason.trim()) throw new Error("A reason is required when withholding borg");
              await put({
                borgReturnedCents: returned,
                borgWithheldCents: withheld,
                borgWithheldReason: withheld > 0 ? withheldReason.trim() : null,
              });
            }
            setStep(5);
          })}
          nextDisabled={busy}
        >
          {received !== null ? (
            <>
              <p className="wiz-sub">Borg received at pickup: {money(received, b.currency)} in {pickup?.borgMethod ?? "cash"}.</p>
              <div className="wiz-choice">
                <button type="button" className={borgChoice === "full" ? "on" : ""} onClick={() => setBorgChoice("full")}>Returned in full</button>
                <button type="button" className={borgChoice === "partial" ? "on" : ""} onClick={() => setBorgChoice("partial")}>Partially withheld</button>
                <button type="button" className={borgChoice === "withheld" ? "on" : ""} onClick={() => setBorgChoice("withheld")}>Fully withheld</button>
              </div>
              {borgChoice === "partial" ? (
                <input className="wiz-input" inputMode="numeric" placeholder={`Amount returned in ${b.currency}`} value={partialReturned} onChange={(e) => setPartialReturned(e.target.value.replace(/\D/g, ""))} />
              ) : null}
              {borgChoice === "partial" || borgChoice === "withheld" ? (
                <textarea className="wiz-input" placeholder="Reason (required when withholding)" value={withheldReason} onChange={(e) => setWithheldReason(e.target.value)} />
              ) : null}
            </>
          ) : (
            <p className="wiz-sub">No borg was recorded at pickup. Nothing to hand back.</p>
          )}
          <button type="button" className="wiz-btn" disabled={busy || ret?.keysReturned} onClick={guarded(async () => {
            await put({ keysReturned: true });
          })}>
            {ret?.keysReturned ? "Keys returned" : "Mark keys returned"}
          </button>
        </StepShell>
      ) : null}

      {!finished && step === 5 ? (
        <StepShell
          step={5} total={TOTAL} title="Finish check-out"
          onBack={() => setStep(4)}
          onNext={guarded(async () => {
            await api(`/api/admin/bookings/${bookingId}/inspection/return/complete`, {});
            toast.show({ type: "success", message: "Checked out. Booking completed." });
            router.push("/admin");
          })}
          nextLabel="Complete check-out"
          nextDisabled={busy}
        >
          <div className="wiz-card">
            {[
              { label: "Six return angles", ok: anglesDone },
              { label: "Damage review saved", ok: ANGLES.every((a) => choices[a.id]) || (ret?.damageFlags.length ?? 0) > 0 },
              { label: "Odometer and fuel", ok: ret?.odometer !== null && ret?.fuelLevel !== null },
              { label: "Keys returned", ok: !!ret?.keysReturned },
              { label: "Borg settled", ok: received === null || ret?.borgReturnedCents !== null },
            ].map((c) => (
              <div className="wiz-check" key={c.label}>
                <span>{c.label}</span>
                <span className={`state ${c.ok ? "ok" : "todo"}`}>{c.ok ? "done" : "open"}</span>
              </div>
            ))}
          </div>
          {(ret?.damageFlags.length ?? 0) > 0 ? (
            <p className="wiz-sub">New damage flagged: the owner gets a warning bell and the summary email mentions it.</p>
          ) : null}
        </StepShell>
      ) : null}
    </main>
  );
}
```

- [ ] Typecheck and lint:

```bash
npx tsc --noEmit && npm run lint
```

- [ ] Manual verification: with the Task 11 booking now `picked_up`, open `http://localhost:3000/admin/inspect/<bookingId>/checkout`, walk the 5 steps (mark one angle "New damage" with a note, withhold part of the borg with a reason), complete. Expect: booking `completed`, a WARNING bell "Car returned with new damage", and (if Resend is configured) a return-summary email in `email_log`.

- [ ] Commit:

```bash
git add "src/app/admin/(shell)/inspect/[bookingId]/checkout/page.tsx"
git commit -m "feat(admin): 5-step check-out wizard with side-by-side comparison and borg button"
```

---

### Task 13: BookingDrawer checklist + inspection panel

**Files:**
- Create: `src/app/admin/(shell)/inspection-panel.tsx`
- Modify: `src/app/admin/(shell)/booking-drawer.tsx` (two-line integration; the file was created by plan 02, so READ IT FIRST — the exact insertion point is described, not quoted)
- Test: none (client component over already-tested routes; typecheck + lint + manual verification)

**Interfaces:**
- Consumes: `GET /api/admin/bookings/[id]/handover`, `PUT /api/admin/bookings/[id]/inspection/[kind]` (Task 9); `apiGet, apiPut` from `@/app/admin/client`; `useToast` from `@/app/admin/_ui`; `Handover`, `InspectionDto`, `fileUrl`, `money`, `FUEL_LABELS` from `./inspect/wizard-ui`; `next/link`.
- Produces: `InspectionPanel({ bookingId, onChanged? }: { bookingId: string; onChanged?: () => void })` — a fully self-contained drawer section: Check in / Check out entry buttons, single-tap checklist toggles (each one an audited PUT), inspection details (photo grid via the same-origin file route, odometer/fuel pair, damage flags, contract download).

**Steps:**

- [ ] Create `src/app/admin/(shell)/inspection-panel.tsx`:

```tsx
"use client";

/**
 * BookingDrawer section: check-in/out entry + the client-asked CHECKLIST
 * ("did we get X?" at a glance) + inspection detail (photos, meters, damage,
 * contract). Self-contained: fetches its own handover payload so the drawer
 * integration is two lines. Every toggle is ONE audited PUT (spec: audit per
 * toggle). Media renders same-origin via /api/admin/files (strict CSP).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, apiPut, type ApiError } from "@/app/admin/client";
import { useToast } from "@/app/admin/_ui";
import { fileUrl, money, FUEL_LABELS, type Handover, type InspectionDto } from "./inspect/wizard-ui";

function Toggle({ label, value, disabled, onTap }: {
  label: string; value: boolean; disabled?: boolean; onTap: () => void;
}) {
  return (
    <div className="wiz-check">
      <span>{label}</span>
      <button type="button" className="wiz-btn ghost" disabled={disabled} onClick={onTap} aria-pressed={value}>
        <span className={`state ${value ? "ok" : "todo"}`}>{value ? "yes" : "no"}</span>
      </button>
    </div>
  );
}

function InspectionDetail({ insp, currency }: { insp: InspectionDto; currency: string }) {
  return (
    <div className="wiz-card">
      <strong>{insp.kind === "pickup" ? "Check-in record" : "Check-out record"}</strong>
      <div className="wiz-row">
        <span className="muted">Odometer</span>
        <span>{insp.odometer ?? "not recorded"}</span>
      </div>
      <div className="wiz-row">
        <span className="muted">Fuel</span>
        <span>{insp.fuelLevel === null ? "not recorded" : FUEL_LABELS[insp.fuelLevel]}</span>
      </div>
      {insp.kind === "return" && insp.borgReturnedCents !== null ? (
        <div className="wiz-row">
          <span className="muted">Borg</span>
          <span>
            {money(insp.borgReturnedCents, currency)} returned
            {insp.borgWithheldCents ? `, ${money(insp.borgWithheldCents, currency)} withheld` : ""}
          </span>
        </div>
      ) : null}
      {insp.damageFlags.map((f) => (
        <div className="wiz-row" key={`${f.photoKey}-${f.note}`}>
          <span className="muted">Damage</span>
          <span>{f.note}</span>
        </div>
      ))}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginTop: 8 }}>
        {insp.photos.map((p) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={p.key} src={fileUrl(p.key)} alt={p.label} title={p.label}
            style={{ width: "100%", height: 72, objectFit: "cover", borderRadius: 6, border: "1px solid #e3e6f0" }} />
        ))}
      </div>
      {insp.contractPdfKey ? (
        <p style={{ marginTop: 8 }}>
          <a href={fileUrl(insp.contractPdfKey)}>Download signed contract (PDF)</a>
        </p>
      ) : null}
    </div>
  );
}

export function InspectionPanel({ bookingId, onChanged }: { bookingId: string; onChanged?: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<Handover | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () =>
    apiGet<Handover>(`/api/admin/bookings/${bookingId}/handover`)
      .then(setData)
      .catch((e: ApiError) => toast.show({ type: "error", message: e.message }));

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  if (!data) return <p className="wiz-sub">Loading handover...</p>;

  const { booking, inspections } = data;
  const pickup = inspections.pickup;
  const ret = inspections.return;

  const toggle = (kind: "pickup" | "return", field: string, next: boolean) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await apiPut(`/api/admin/bookings/${bookingId}/inspection/${kind}`, { [field]: next });
      await reload();
      onChanged?.();
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {booking.status === "pending" || booking.status === "confirmed" ? (
        <Link className="wiz-btn primary" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
          href={`/admin/inspect/${bookingId}/checkin`}>
          Check in
        </Link>
      ) : null}
      {booking.status === "picked_up" ? (
        <Link className="wiz-btn primary" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
          href={`/admin/inspect/${bookingId}/checkout`}>
          Check out
        </Link>
      ) : null}

      {booking.status !== "cancelled" ? (
        <div className="wiz-card" style={{ marginTop: 8 }}>
          <strong>Checklist</strong>
          <Toggle label="Agreement signed" value={!!pickup?.agreementSigned} disabled={busy}
            onTap={toggle("pickup", "agreementSigned", !pickup?.agreementSigned)} />
          <Toggle label="Rules signed" value={!!pickup?.rulesSigned} disabled={busy}
            onTap={toggle("pickup", "rulesSigned", !pickup?.rulesSigned)} />
          <Toggle label="Licence copy received" value={!!pickup?.licenseCopyReceived} disabled={busy}
            onTap={toggle("pickup", "licenseCopyReceived", !pickup?.licenseCopyReceived)} />
          <div className="wiz-check">
            <span>Borg received</span>
            <span className={`state ${pickup?.borgReceivedCents !== null && pickup?.borgReceivedCents !== undefined ? "ok" : "todo"}`}>
              {pickup?.borgReceivedCents !== null && pickup?.borgReceivedCents !== undefined
                ? money(pickup.borgReceivedCents, booking.currency)
                : "no"}
            </span>
          </div>
          {booking.status === "picked_up" || booking.status === "completed" ? (
            <Toggle label="Keys returned" value={!!ret?.keysReturned} disabled={busy}
              onTap={toggle("return", "keysReturned", !ret?.keysReturned)} />
          ) : null}
        </div>
      ) : null}

      {pickup && pickup.photos.length > 0 ? <InspectionDetail insp={pickup} currency={booking.currency} /> : null}
      {ret && ret.photos.length > 0 ? <InspectionDetail insp={ret} currency={booking.currency} /> : null}
    </div>
  );
}
```

- [ ] Integrate into the drawer. READ `src/app/admin/(shell)/booking-drawer.tsx` first (plan 02 created it; its internals are its own). Then:
  1. Add the import near the other local imports: `import { InspectionPanel } from "./inspection-panel";`
  2. Locate where the drawer renders its content sections for the selected booking (plan 02's seam defines the order: summary, payments, then actions). Insert `<InspectionPanel bookingId={<the booking id the drawer displays>} onChanged={<the drawer's data-refresh callback, if it has one; otherwise omit the prop>} />` BETWEEN the payments section and the actions section. The panel supplies its own "Check in" / "Check out" buttons, so do NOT add those to the drawer's action row.
  3. If the drawer gates sections by status, render the panel for every status except none at all: the panel itself handles `cancelled` (hides the checklist) and shows the right wizard button per status.

- [ ] Typecheck and lint:

```bash
npx tsc --noEmit && npm run lint
```

- [ ] Manual verification: on the planning board, click a confirmed booking's bar → the drawer opens → the panel shows "Check in" plus the checklist with every item "no". Tap "Licence copy received" → it flips to "yes" and `/admin/audit` shows a fresh `admin.inspection_updated` entry. After a full check-in, the drawer shows the photo grid, meters, and the contract download link.

- [ ] Commit:

```bash
git add "src/app/admin/(shell)/inspection-panel.tsx" "src/app/admin/(shell)/booking-drawer.tsx"
git commit -m "feat(admin): drawer inspection panel with single-tap audited checklist and wizard entry"
```

---

### Task 14: Inspection media retention sweep on the daily cron

**Files:**
- Modify: `src/lib/admin/inspections.ts` (append `sweepInspectionMedia`)
- Modify: `src/app/api/cron/expire-holds/route.ts` (invoke the sweep; full new file body below)
- Test: `src/test/inspection-retention.test.ts`

**Interfaces:**
- Consumes: `getSettings` from `@/lib/admin/settings` (`settings.licenseRetentionDays`, default 90 — the existing retention knob; spec open-detail A says to follow this pattern); `deleteObject` from `@/lib/storage`; drizzle `lt` operator; the existing cron shape (`CRON_SECRET` bearer, vercel.json already schedules `/api/cron/expire-holds` daily at `0 3 * * *` — no vercel.json change needed).
- Produces: `sweepInspectionMedia(now?: Date): Promise<number>` — for every inspection whose booking is `completed` with `endAt` older than `licenseRetentionDays` days: deletes the walk-around/damage photos, licence photo, and signature from storage, blanks their keys (damage NOTES are kept, their dangling `photoKey`s blanked), and KEEPS the contract PDF (a business record, not PII media). Returns how many inspections were purged. Idempotent: already-purged rows have no keys and are skipped.

**Steps:**

- [ ] Write the failing test `src/test/inspection-retention.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings, adminUsers, inspections } from "@/lib/db/schema";
import { upsertInspection, sweepInspectionMedia } from "@/lib/admin/inspections";
import { putObject, getObject } from "@/lib/storage";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "", adminId = "";
let month = 1;

const DAY = 86_400_000;

async function mkCompleted(key: string, endDaysAgo: number) {
  const m = String(month++).padStart(2, "0");
  const end = new Date(Date.now() - endDaysAgo * DAY);
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId,
    startAt: new Date(end.getTime() - 4 * DAY),
    endAt: end,
    bufferEndAt: new Date(end.getTime() + DAY),
    status: "completed",
    priceBreakdown: { subtotalCents: 40000, currency: "USD" },
    paymentOption: "deposit", acceptedPolicyVersion: 1, acceptedAt: new Date(),
    idempotencyKey: `${key}-${m}`,
  }).returning();
  return b!;
}

async function seedMedia(bookingId: string) {
  const photoKey = `inspections/${bookingId}/pickup/front.jpg`;
  const licKey = `licenses/${bookingId}/a.jpg`;
  const sigKey = `signatures/${bookingId}.png`;
  const pdfKey = `contracts/${bookingId}.pdf`;
  for (const k of [photoKey, licKey, sigKey, pdfKey]) {
    await putObject(k, new Uint8Array([1, 2, 3]), "application/octet-stream");
  }
  await upsertInspection(bookingId, "pickup", {
    photos: [{ key: photoKey, label: "front" }],
    licensePhotoKey: licKey,
    signatureKey: sigKey,
    damageFlags: [{ photoKey, note: "old scratch" }],
  }, adminId);
  await db.update(inspections).set({ contractPdfKey: pdfKey })
    .where(and(eq(inspections.bookingId, bookingId), eq(inspections.kind, "pickup")));
  return { photoKey, licKey, sigKey, pdfKey };
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "sweep-car", plate: "PL-sweep", class: "SUV", name: "Sweep Car", seats: 5,
    transmission: "Automatic", doors: 5, priceDayCents: 1, priceWeekCents: 1, priceMonthCents: 1,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "sweep@test.com" }).returning();
  const [a] = await db.insert(adminUsers).values({ email: "sweep-admin@test.com", passwordHash: "x" }).returning();
  vehicleId = v!.id; customerId = c!.id; adminId = a!.id;
});

afterAll(async () => {
  await rm(path.resolve(process.cwd(), ".dev-storage"), { recursive: true, force: true });
});

describe("sweepInspectionMedia", () => {
  it("purges media past licenseRetentionDays (default 90) but KEEPS the contract", async () => {
    const b = await mkCompleted("sweep-old", 200);
    const { photoKey, licKey, sigKey, pdfKey } = await seedMedia(b.id);

    const purged = await sweepInspectionMedia();
    expect(purged).toBeGreaterThanOrEqual(1);

    const [insp] = await db.select().from(inspections).where(eq(inspections.bookingId, b.id));
    expect(insp!.photos).toEqual([]);
    expect(insp!.licensePhotoKey).toBeNull();
    expect(insp!.signatureKey).toBeNull();
    expect(insp!.contractPdfKey).toBe(pdfKey);
    expect(insp!.damageFlags).toEqual([{ photoKey: "", note: "old scratch" }]); // notes survive

    await expect(getObject(photoKey)).rejects.toThrow();
    await expect(getObject(licKey)).rejects.toThrow();
    await expect(getObject(sigKey)).rejects.toThrow();
    await expect(getObject(pdfKey)).resolves.toBeTruthy(); // contract stays
  });

  it("leaves recent completed bookings alone and is idempotent", async () => {
    const recent = await mkCompleted("sweep-recent", 5);
    const { photoKey } = await seedMedia(recent.id);

    const first = await sweepInspectionMedia();
    const [insp] = await db.select().from(inspections).where(eq(inspections.bookingId, recent.id));
    expect(insp!.photos).toHaveLength(1);
    await expect(getObject(photoKey)).resolves.toBeTruthy();

    const second = await sweepInspectionMedia();
    expect(second).toBeLessThanOrEqual(first); // nothing new to purge on the second run
  });
});
```

- [ ] Run it to verify it fails:

```bash
npm test -- --no-file-parallelism src/test/inspection-retention.test.ts
```

Expected failure: `sweepInspectionMedia` is not exported from `@/lib/admin/inspections`.

- [ ] Append to `src/lib/admin/inspections.ts` (add `lt` to the existing drizzle-orm import, `deleteObject` to the existing `@/lib/storage` import, and `getSettings` from `@/lib/admin/settings`):

```ts
/**
 * Retention sweep (spec open-detail A: follow the licenseRetentionDays
 * pattern). Once a completed rental is older than the retention window, the
 * PII-bearing media (walk-around photos, licence photo, signature) is deleted
 * from storage and the keys blanked. Damage NOTES stay (business record, no
 * PII), and the CONTRACT PDF stays (the signed agreement is the proof the
 * versioned-policies system exists for). Runs from the daily cron.
 */
export async function sweepInspectionMedia(now = new Date()): Promise<number> {
  const db = await getDb();
  const settings = await getSettings();
  const cutoff = new Date(now.getTime() - settings.licenseRetentionDays * 86_400_000);

  const rows = await db.select({ insp: inspections })
    .from(inspections)
    .innerJoin(bookings, eq(inspections.bookingId, bookings.id))
    .where(and(eq(bookings.status, "completed"), lt(bookings.endAt, cutoff)));

  let purged = 0;
  for (const { insp } of rows) {
    const keys = [
      ...insp.photos.map((p) => p.key),
      insp.licensePhotoKey,
      insp.signatureKey,
    ].filter((k): k is string => !!k);
    if (keys.length === 0) continue; // already purged — idempotent

    for (const key of keys) {
      await deleteObject(key).catch((e) =>
        logger.warn("inspection_media_delete_failed", { key, error: (e as Error).message }),
      );
    }
    await db.update(inspections).set({
      photos: [],
      licensePhotoKey: null,
      signatureKey: null,
      damageFlags: insp.damageFlags.map((f) => ({ photoKey: "", note: f.note })),
    }).where(eq(inspections.id, insp.id));
    purged++;
  }
  return purged;
}
```

- [ ] Replace `src/app/api/cron/expire-holds/route.ts` with (same auth, same schedule, one more chore — vercel.json already points here daily):

```ts
import { NextResponse } from "next/server";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { expireStaleHolds } from "@/lib/payments/holds";
import { sweepInspectionMedia } from "@/lib/admin/inspections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/expire-holds — daily maintenance, called by Vercel Cron (see
 * vercel.json). Authenticated by the CRON_SECRET bearer token; refuses to run
 * without it. Two chores: cancel stale unpaid pending holds, and purge
 * inspection media past the licenseRetentionDays window (wave 06).
 */
export async function GET(req: Request): Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  if (!env.CRON_SECRET || auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const cancelled = await expireStaleHolds(30); // holds older than 30 min, unpaid
  const mediaPurged = await sweepInspectionMedia();
  logger.info("cron_expire_holds", { cancelled, mediaPurged });
  return NextResponse.json({ ok: true, cancelled, mediaPurged });
}
```

(If an earlier wave plan already modified this route, keep its additions and ADD the `sweepInspectionMedia()` call + response field alongside them.)

- [ ] Run the test to verify it passes:

```bash
npm test -- --no-file-parallelism src/test/inspection-retention.test.ts
```

Expected: 2 tests pass.

- [ ] Commit:

```bash
git add src/lib/admin/inspections.ts src/app/api/cron/expire-holds/route.ts src/test/inspection-retention.test.ts
git commit -m "feat(retention): purge inspection media past licenseRetentionDays on the daily cron"
```

---

### Task 15: Wave-06 verification pass

**Files:**
- Modify: none (verification only; fix regressions in place if any step fails)

**Interfaces:**
- Consumes: everything above.
- Produces: a green gate for plan 07 (reports reads the borg fields written here) and plan 09 (Tex port).

**Steps:**

- [ ] Full suite:

```bash
npm test -- --no-file-parallelism
```

Expected: every file green, including the pre-wave ~199 tests and this plan's new files (`storage-local`, `inspections-schema`, `upload-validation`, `inspections`, `pdf-contract`, `checkin-emails`, `inspection-complete`, `inspection-retention`). Any red test is a regression to fix before proceeding.

- [ ] Typecheck and lint:

```bash
npx tsc --noEmit && npm run lint
```

- [ ] End-to-end manual smoke (dev server; NEVER build while it runs):
  1. `npm run dev`, sign in to `/admin`.
  2. Board → click a confirmed booking bar → drawer shows the Inspection panel with "Check in" and the checklist.
  3. Run the full check-in (7 steps) → bar turns `picked_up` (plan 01's bar state), bell rings, contract PDF downloads from the drawer.
  4. Drawer now shows "Check out" → run the 5 steps with one damage flag + partial borg → booking `completed`, warning bell.
  5. `/admin/audit` lists `admin.file_uploaded`, `admin.inspection_updated` (one per toggle), `admin.desk_payment_recorded`, `admin.checkin_completed`, `admin.checkout_completed`.
  6. `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/expire-holds` → `{ ok: true, cancelled: n, mediaPurged: n }`.

- [ ] Confirm no stray artifacts are staged: `git status` must show a clean tree (`.dev-storage/` is gitignored).

- [ ] Commit any verification fixes with `fix(...)` scope messages; if nothing changed, no commit — the plan is done.

---

## Deployment notes (for the operator, not a task)

- Production env: `STORAGE_DRIVER=supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `STORAGE_BUCKET=fleet-docs`. Create the `fleet-docs` bucket in Supabase with "Public bucket" OFF before the first check-in.
- Dev/preview needs nothing: the local driver is the default and writes to `.dev-storage/`.
- The daily cron (`vercel.json`, already present) now also purges old inspection media; no schedule change.
