import { z } from "zod";
import { lt, desc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";

export type AuditRow = typeof auditLog.$inferSelect;

export const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime().optional(), // ISO timestamp cursor
});

/** Newest-first audit page (read-only; the table has no mutation path). */
export async function listAudit(q: z.infer<typeof AuditQuerySchema>): Promise<AuditRow[]> {
  const db = await getDb();
  const base = db.select().from(auditLog);
  const rows = q.before
    ? await base.where(lt(auditLog.createdAt, new Date(q.before))).orderBy(desc(auditLog.createdAt)).limit(q.limit)
    : await base.orderBy(desc(auditLog.createdAt)).limit(q.limit);
  return rows;
}
