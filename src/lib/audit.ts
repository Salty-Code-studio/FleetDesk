/**
 * Append-only audit trail (spec §5: every admin action logged). Inserts must
 * never break the calling flow: failures are logged, not thrown.
 */
import { getDb } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { trustedClientIp } from "@/lib/http/client-ip";

export interface AuditEntry {
  actor: string; // admin user id, customer id, or "anonymous"/"system"
  action: string; // dotted verb, e.g. "admin.login_failed"
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  req?: Request;
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(auditLog).values({
      actor: entry.actor,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      // Trusted only behind a proxy that overwrites the header; otherwise null,
      // so a client cannot forge the IP recorded against their own actions.
      ip: entry.req ? trustedClientIp(entry.req) : null,
      ua: entry.req?.headers.get("user-agent") ?? null,
    });
  } catch (error) {
    logger.error("audit_write_failed", { action: entry.action, error: (error as Error).message });
  }
}
