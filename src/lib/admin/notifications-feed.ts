/** Read/mark queries for the admin in-app notification bell. */
import { and, desc, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { notifications } from "@/lib/db/schema";

export async function listNotifications(limit = 30) {
  const db = await getDb();
  const rows = await db.select().from(notifications).orderBy(desc(notifications.createdAt)).limit(limit);
  const [c] = await db.select({ count: sql<number>`count(*)::int` })
    .from(notifications).where(isNull(notifications.readAt));
  return { notifications: rows, unread: Number(c?.count ?? 0) };
}

/** Mark the given ids read, or ALL unread read when no ids are given. */
export async function markNotificationsRead(ids?: string[]): Promise<{ marked: number }> {
  const db = await getDb();
  const now = new Date();
  const where = ids && ids.length
    ? and(inArray(notifications.id, ids), isNull(notifications.readAt))
    : isNull(notifications.readAt);
  const res = await db.update(notifications).set({ readAt: now }).where(where).returning({ id: notifications.id });
  return { marked: res.length };
}
