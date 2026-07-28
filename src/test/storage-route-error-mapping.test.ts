/**
 * Regression test for the storage-file-route observability defect: both
 * GET /api/admin/files/[...key] and GET /api/dev/storage/[...key] used to do
 *
 *   const { data, contentType } = await getObject(key).catch(() => {
 *     throw Errors.notFound("File not found");
 *   });
 *
 * which rewrites EVERY storage failure -- a Supabase 5xx, a network fault, a
 * rotated service-role key, even an invalid-key badRequest from
 * assertSafeKey() -- into a 404, discarding the real cause. On-call then sees
 * a benign warn-level "File not found" during an actual storage outage
 * instead of an error-level alert.
 *
 * The fix must distinguish a GENUINE driver not-found (Node's ENOENT locally,
 * Supabase's semantic 404 in prod) from every other failure, and let real
 * failures propagate as a 500 (or whatever their own AppError status already
 * is) so they log at error level.
 *
 * getObject is mocked here so each failure mode can be driven directly and
 * deterministically, independent of the real local/Supabase drivers (which
 * are exercised elsewhere, e.g. src/test/storage-local.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { createStaff } from "@/lib/admin/staff";
import { createSession } from "@/lib/auth/sessions";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { Errors } from "@/lib/http/errors";
import { signLocalUrl } from "@/lib/storage/local";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name)! } : undefined),
  }),
}));

vi.mock("@/lib/storage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/storage")>("@/lib/storage");
  return { ...actual, getObject: vi.fn() };
});

// Imported AFTER the mocks above; vi.mock is hoisted by vitest so this
// resolves against the mocked modules regardless of import order.
import { getObject } from "@/lib/storage";
import { GET as filesGET } from "@/app/api/admin/files/[...key]/route";
import { GET as devStorageGET } from "@/app/api/dev/storage/[...key]/route";

const mockedGetObject = vi.mocked(getObject);

beforeAll(async () => {
  await runMigrations();
  const staff = await createStaff("File Route Tester");
  const session = await createSession({ subjectType: "admin", subjectId: staff.id });
  cookieJar.set(SESSION_COOKIE, session.cookieValue);
});

afterAll(async () => {
  await rm(path.resolve(process.cwd(), ".dev-storage"), { recursive: true, force: true });
});

function filesRequest(key: string) {
  const req = new Request(`http://localhost:3000/api/admin/files/${key}`, {
    headers: { origin: "http://localhost:3000" },
  });
  return filesGET(req, { params: Promise.resolve({ key: key.split("/") }) });
}

function devRequest(key: string) {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const sig = signLocalUrl(key, exp);
  const req = new Request(`http://localhost:3000/api/dev/storage/${key}?exp=${exp}&sig=${sig}`);
  return devStorageGET(req, { params: Promise.resolve({ key: key.split("/") }) });
}

describe.each([
  { name: "GET /api/admin/files/[...key]", request: filesRequest },
  { name: "GET /api/dev/storage/[...key]", request: devRequest },
])("$name — storage failure -> HTTP status mapping", ({ request }) => {
  it("maps a genuine driver not-found (Node ENOENT) to 404", async () => {
    mockedGetObject.mockRejectedValueOnce(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }));
    const res = await request("inspections/missing/pickup/a.jpg");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
  });

  it("maps a genuine driver not-found (Supabase semantic 404 in the cause) to 404", async () => {
    const wrapped = new Error("storage download failed for x: Object not found", {
      cause: { statusCode: "404", status: 400, message: "Object not found" },
    });
    mockedGetObject.mockRejectedValueOnce(wrapped);
    const res = await request("inspections/missing/pickup/a.jpg");
    expect(res.status).toBe(404);
  });

  it("propagates a REAL storage failure (e.g. Supabase 5xx / network fault) as a 500, NOT a 404", async () => {
    mockedGetObject.mockRejectedValueOnce(
      new Error("storage download failed for x: fetch failed", { cause: { statusCode: "500", status: 500 } }),
    );
    const res = await request("inspections/x/pickup/a.jpg");
    const body = await res.json();
    // This is the RED assertion pre-fix: the old code turned this into a 404
    // ("File not found") and silently discarded the real cause.
    expect(res.status).toBe(500);
    expect(body.error.code).toBe("internal_error");
  });

  it("does not collapse an existing AppError (e.g. an invalid-key badRequest) into a 404", async () => {
    mockedGetObject.mockRejectedValueOnce(Errors.badRequest("Invalid storage key"));
    const res = await request("inspections/x/pickup/a.jpg");
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("bad_request");
  });

  it("still serves the object on success", async () => {
    mockedGetObject.mockResolvedValueOnce({ data: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" });
    const res = await request("inspections/x/pickup/a.jpg");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3]);
  });
});
