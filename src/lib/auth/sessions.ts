/**
 * Postgres-backed server-side sessions (spec §4, fort authn-session).
 *
 * Cookie value: `<sid>.<HMAC-SHA256(sid, SESSION_SECRET)>` — the HMAC rejects
 * tampered/forged ids without a database hit. The database stores ONLY
 * sha256(sid): a database leak cannot produce a usable cookie.
 *
 * Expiry, two independent clocks (both fail-closed):
 *   - absolute: expiresAt = createdAt + SESSION_TTL_SECONDS, never extended
 *   - idle: lastSeenAt + SESSION_IDLE_TTL_SECONDS, touched on use (throttled)
 *
 * Rotation: on every privilege change (login, MFA completion) the session id
 * is REPLACED, never reused — defeats session fixation.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { env } from "@/env";
import { getDb } from "@/lib/db/client";
import { sessions } from "@/lib/db/schema";

const SID_BYTES = 32; // 256 bits of entropy
const TOUCH_THROTTLE_MS = 60_000; // avoid an UPDATE per request

export type SessionRecord = typeof sessions.$inferSelect;
export type SubjectType = "admin" | "customer";

function sign(value: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(value).digest("base64url");
}

function pack(id: string): string {
  return `${id}.${sign(id)}`;
}

/** Verify + extract the raw sid from a signed cookie value (constant-time). */
export function unpack(cookieValue: string): string | null {
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = cookieValue.slice(0, dot);
  const mac = cookieValue.slice(dot + 1);
  const a = Buffer.from(mac);
  const b = Buffer.from(sign(id));
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return id;
}

function hashSid(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

export interface CreatedSession {
  cookieValue: string;
  csrfToken: string;
  record: SessionRecord;
}

export interface CreateSessionInput {
  subjectType: SubjectType;
  subjectId: string;
  mfaPending?: boolean;
  ip?: string | null;
  ua?: string | null;
  /** Preserve an existing absolute deadline across rotation (see rotateSession). */
  preserveExpiry?: { createdAt: Date; expiresAt: Date };
}

export async function createSession(input: CreateSessionInput): Promise<CreatedSession> {
  const db = await getDb();
  const id = randomBytes(SID_BYTES).toString("base64url");
  const csrfToken = randomBytes(SID_BYTES).toString("base64url");
  const now = new Date();
  const createdAt = input.preserveExpiry?.createdAt ?? now;
  const expiresAt = input.preserveExpiry?.expiresAt ?? new Date(now.getTime() + env.SESSION_TTL_SECONDS * 1000);
  const [record] = await db.insert(sessions).values({
    idHash: hashSid(id),
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    csrfToken,
    mfaPending: input.mfaPending ?? false,
    ip: input.ip ?? null,
    ua: input.ua ?? null,
    createdAt,
    lastSeenAt: now,
    expiresAt,
  }).returning();
  return { cookieValue: pack(id), csrfToken, record: record! };
}

/**
 * Resolve a signed cookie value to a live session, or null. Enforces both
 * expiries and touches lastSeenAt (throttled). `now` is injectable for tests.
 */
export async function resolveSession(
  cookieValue: string | undefined,
  now = new Date(),
): Promise<SessionRecord | null> {
  if (!cookieValue) return null;
  const id = unpack(cookieValue);
  if (!id) return null;
  const db = await getDb();
  const [record] = await db.select().from(sessions).where(eq(sessions.idHash, hashSid(id)));
  if (!record) return null;

  if (record.expiresAt.getTime() <= now.getTime()) {
    await db.delete(sessions).where(eq(sessions.idHash, record.idHash));
    return null;
  }
  const idleDeadline = record.lastSeenAt.getTime() + env.SESSION_IDLE_TTL_SECONDS * 1000;
  if (idleDeadline <= now.getTime()) {
    await db.delete(sessions).where(eq(sessions.idHash, record.idHash));
    return null;
  }
  if (now.getTime() - record.lastSeenAt.getTime() > TOUCH_THROTTLE_MS) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.idHash, record.idHash));
    record.lastSeenAt = now;
  }
  return record;
}

/**
 * Replace a session with a fresh id + CSRF token (same subject). Used at every
 * privilege boundary: password login → mfa-pending, MFA success → full.
 * The absolute deadline is INHERITED, not reset — the hard cap is measured from
 * first authentication, so in-flow rotations can't extend a session's lifetime.
 */
export async function rotateSession(
  current: SessionRecord,
  changes: { mfaPending?: boolean } = {},
): Promise<CreatedSession> {
  const db = await getDb();
  await db.delete(sessions).where(eq(sessions.idHash, current.idHash));
  return createSession({
    subjectType: current.subjectType,
    subjectId: current.subjectId,
    mfaPending: changes.mfaPending ?? current.mfaPending,
    ip: current.ip,
    ua: current.ua,
    preserveExpiry: { createdAt: current.createdAt, expiresAt: current.expiresAt },
  });
}

export async function destroySession(cookieValue: string | undefined): Promise<void> {
  if (!cookieValue) return;
  const id = unpack(cookieValue);
  if (!id) return;
  const db = await getDb();
  await db.delete(sessions).where(eq(sessions.idHash, hashSid(id)));
}

/** Revoke every session for a subject (password change, account lock, offboarding). */
export async function destroyAllForSubject(subjectType: SubjectType, subjectId: string): Promise<void> {
  const db = await getDb();
  await db.delete(sessions).where(
    and(eq(sessions.subjectType, subjectType), eq(sessions.subjectId, subjectId)),
  );
}

/** Housekeeping: remove rows past their absolute expiry (cron-able later). */
export async function purgeExpiredSessions(now = new Date()): Promise<void> {
  const db = await getDb();
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
}
