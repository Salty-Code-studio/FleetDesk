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
