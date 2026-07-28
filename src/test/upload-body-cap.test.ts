/**
 * Regression test for the multipart-upload memory-exhaustion defect:
 * POST /api/admin/uploads used to call req.formData() (which buffers the
 * ENTIRE multipart body in memory) and only THEN check file.size against the
 * 10MB cap — an authenticated staff/owner could OOM the process with a
 * multi-GB part before that check ever ran. The fix rejects an oversized
 * DECLARED Content-Length up front, before req.formData() is called at all,
 * mirroring the early declared-length check parseJsonBody already does for
 * the JSON path (src/lib/http/validate.ts).
 *
 * This drives the real route handler (not just the validation helper) so the
 * test fails red against the actual pre-fix behavior: today, a huge declared
 * Content-Length does NOT stop the request — it sails through to a 201.
 *
 * The admin guard reads cookies via next/headers' `cookies()`, which throws
 * ("called outside a request scope") unless called inside a live Next
 * request. Outside of that, we stand in a tiny in-memory cookie jar the way
 * a real request's parsed cookies would supply one, isolated to this file.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings } from "@/lib/db/schema";
import { createStaff } from "@/lib/admin/staff";
import { createSession } from "@/lib/auth/sessions";
import { SESSION_COOKIE, CSRF_COOKIE } from "@/lib/auth/cookies";
import { MAX_UPLOAD_BYTES } from "@/lib/storage/uploads";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name)! } : undefined),
  }),
}));

// Imported AFTER the mock is registered above; vi.mock is hoisted by vitest
// so this resolves against the mocked next/headers regardless of ordering.
import { POST } from "@/app/api/admin/uploads/route";

let bookingId = "";

beforeAll(async () => {
  await runMigrations();
  const db = await getDb();
  const [v] = await db.insert(vehicles).values({
    slug: "cap-test-car", plate: "CAP-1", class: "Economy", name: "Cap Test Car", seats: 5,
    transmission: "Automatic", doors: 4, priceDayCents: 4000, priceWeekCents: 24000, priceMonthCents: 80000,
    depositCents: 25000,
  }).returning();
  const [c] = await db.insert(customers).values({ email: "cap-test@example.com" }).returning();
  const [b] = await db.insert(bookings).values({
    vehicleId: v!.id, customerId: c!.id,
    startAt: "2027-01-01T13:00:00Z", endAt: "2027-01-05T13:00:00Z", bufferEndAt: "2027-01-06T13:00:00Z",
    status: "confirmed",
    priceBreakdown: { subtotalCents: 40000, vehicleCents: 40000, insuranceCents: 0, addOns: [], addOnsCents: 0, days: 4, currency: "USD" },
    paymentOption: "deposit", acceptedPolicyVersion: 1, acceptedAt: new Date(),
    idempotencyKey: randomUUID(),
  }).returning();
  bookingId = b!.id;

  const staff = await createStaff("Cap Tester");
  const session = await createSession({ subjectType: "admin", subjectId: staff.id });
  cookieJar.set(SESSION_COOKIE, session.cookieValue);
  cookieJar.set(CSRF_COOKIE, session.csrfToken);
});

afterAll(async () => {
  await rm(path.resolve(process.cwd(), ".dev-storage"), { recursive: true, force: true });
});

function multipartRequest(opts: { contentLength?: string; fileSize?: number }) {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(opts.fileSize ?? 1000)], "x.jpg", { type: "image/jpeg" }));
  fd.set("category", "license");
  fd.set("bookingId", bookingId);
  const headers: Record<string, string> = {
    origin: "http://localhost:3000",
    "x-csrf-token": cookieJar.get(CSRF_COOKIE)!,
  };
  if (opts.contentLength !== undefined) headers["content-length"] = opts.contentLength;
  const req = new Request("http://localhost:3000/api/admin/uploads", { method: "POST", headers, body: fd });
  return POST(req, { params: Promise.resolve({}) });
}

describe("POST /api/admin/uploads — Content-Length cap (memory-exhaustion guard)", () => {
  it("rejects a request whose declared Content-Length exceeds the multipart cap, before formData() is called", async () => {
    // A declared size far past the 10MB file limit — an honest declaration of
    // this size is exactly the multi-GB-part attack the fix closes. The
    // ACTUAL body sent here is tiny (10 bytes) precisely to prove the
    // rejection is driven by the header alone, before any parsing/buffering
    // of the body is attempted.
    const hugeDeclared = String(MAX_UPLOAD_BYTES + 500 * 1024 * 1024); // ~500MB over the file cap
    const res = await multipartRequest({ contentLength: hugeDeclared, fileSize: 10 });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.message).toMatch(/too large/i);
  });

  it("still accepts a normal-sized upload with a normal declared Content-Length", async () => {
    const res = await multipartRequest({ contentLength: "600000", fileSize: 500_000 });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toMatch(/^licenses\//);
  });

  it("still accepts a normal upload when Content-Length is absent (e.g. chunked transfer)", async () => {
    const res = await multipartRequest({ fileSize: 500_000 });
    expect(res.status).toBe(201);
  });
});
