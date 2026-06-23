import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { sessions, adminUsers } from "@/lib/db/schema";
import {
  createSession, resolveSession, rotateSession, destroySession,
  destroyAllForSubject, unpack,
} from "@/lib/auth/sessions";
import { env } from "@/env";

let db: Awaited<ReturnType<typeof getDb>>;
let adminId = "";

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [a] = await db.insert(adminUsers).values({
    email: "sess-test@fleetdesk.app", passwordHash: "$argon2id$test-placeholder",
  }).returning({ id: adminUsers.id });
  adminId = a!.id;
});

const mk = (over: Partial<Parameters<typeof createSession>[0]> = {}) =>
  createSession({ subjectType: "admin", subjectId: adminId, ...over });

describe("postgres sessions", () => {
  it("creates and resolves a session", async () => {
    const { cookieValue, csrfToken } = await mk();
    const resolved = await resolveSession(cookieValue);
    expect(resolved?.subjectId).toBe(adminId);
    expect(resolved?.csrfToken).toBe(csrfToken);
    expect(resolved?.mfaPending).toBe(false);
  });

  it("stores only a hash of the sid, never the raw value", async () => {
    const { cookieValue } = await mk();
    const rawSid = unpack(cookieValue)!;
    const rows = await db.select().from(sessions);
    expect(rows.some((r) => r.idHash === rawSid)).toBe(false);
    expect(rows.some((r) => r.idHash.length === 64)).toBe(true); // sha256 hex
  });

  it("rejects a tampered cookie", async () => {
    const { cookieValue } = await mk();
    const flipped = cookieValue.slice(0, -2) + (cookieValue.endsWith("aa") ? "bb" : "aa");
    expect(await resolveSession(flipped)).toBeNull();
    expect(await resolveSession("garbage")).toBeNull();
    expect(await resolveSession(undefined)).toBeNull();
  });

  it("enforces the idle timeout", async () => {
    const { cookieValue } = await mk();
    const later = new Date(Date.now() + (env.SESSION_IDLE_TTL_SECONDS + 5) * 1000);
    expect(await resolveSession(cookieValue, later)).toBeNull();
    // and the row is gone (fail-closed cleanup)
    expect(await resolveSession(cookieValue)).toBeNull();
  });

  it("enforces the absolute timeout even with recent activity", async () => {
    const { cookieValue, record } = await mk();
    // keep it "active" but move past absolute expiry
    await db.update(sessions)
      .set({ lastSeenAt: new Date(record.expiresAt.getTime() - 1000) })
      .where(eq(sessions.idHash, record.idHash));
    const later = new Date(record.expiresAt.getTime() + 1000);
    expect(await resolveSession(cookieValue, later)).toBeNull();
  });

  it("rotation issues a new id and invalidates the old one", async () => {
    const first = await mk({ mfaPending: true });
    const rotated = await rotateSession(first.record, { mfaPending: false });
    expect(rotated.cookieValue).not.toBe(first.cookieValue);
    expect(rotated.csrfToken).not.toBe(first.csrfToken);
    expect(await resolveSession(first.cookieValue)).toBeNull(); // fixation defense
    const live = await resolveSession(rotated.cookieValue);
    expect(live?.mfaPending).toBe(false);
  });

  it("rotation inherits the absolute deadline (hard cap from first login, not reset)", async () => {
    const first = await mk();
    const rotated = await rotateSession(first.record);
    // same absolute expiry carried over despite a new createdAt-eligible row
    expect(rotated.record.expiresAt.getTime()).toBe(first.record.expiresAt.getTime());
    expect(rotated.record.createdAt.getTime()).toBe(first.record.createdAt.getTime());
    // and the rotated session dies at the ORIGINAL absolute deadline
    const past = new Date(first.record.expiresAt.getTime() + 1000);
    expect(await resolveSession(rotated.cookieValue, past)).toBeNull();
  });

  it("destroySession and destroyAllForSubject revoke access", async () => {
    const a = await mk();
    await destroySession(a.cookieValue);
    expect(await resolveSession(a.cookieValue)).toBeNull();

    const b = await mk();
    const c = await mk();
    await destroyAllForSubject("admin", adminId);
    expect(await resolveSession(b.cookieValue)).toBeNull();
    expect(await resolveSession(c.cookieValue)).toBeNull();
  });
});
