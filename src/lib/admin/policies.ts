import { z } from "zod";
import { eq, and, desc, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { policies } from "@/lib/db/schema";
import { isUniqueViolation } from "@/lib/db/errors";
import { Errors } from "@/lib/http/errors";

export type Policy = typeof policies.$inferSelect;
export type PolicyType = "rental_terms" | "cancellation" | "privacy";

export const PolicyPublishSchema = z.object({
  type: z.enum(["rental_terms", "cancellation", "privacy"]),
  body: z.string().trim().min(1, "policy body is required").max(50_000),
}).strict();

/**
 * Publish a NEW version of a policy. We never UPDATE an existing row — each
 * publish is a new immutable version (spec §10: older versions kept for proof,
 * bookings reference the version they accepted).
 */
export async function publishPolicy(input: z.infer<typeof PolicyPublishSchema>): Promise<Policy> {
  const db = await getDb();
  // Assign the next version ATOMICALLY in a single INSERT…SELECT, so the
  // max(version) read and the insert can't interleave within one connection.
  // On a multi-connection Postgres two sessions could still both compute the
  // same version and one hits the (type, version) unique index — we recompute
  // and retry, so racing publishes become distinct versions, never a 500.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const result = (await db.execute(sql`
        INSERT INTO policies (type, version, body, published_at)
        SELECT ${input.type}::policy_type, coalesce(max(version), 0) + 1, ${input.body}, now()
        FROM policies WHERE type = ${input.type}::policy_type
        RETURNING id, type, version, body, published_at AS "publishedAt"
      `)) as { rows: unknown[] } | unknown[];
      const rows = (Array.isArray(result) ? result : result.rows) as Array<{
        id: string; type: PolicyType; version: number; body: string; publishedAt: string | Date;
      }>;
      const r = rows[0]!;
      return { ...r, version: Number(r.version), publishedAt: new Date(r.publishedAt) };
    } catch (e) {
      if (isUniqueViolation(e) && attempt < 7) continue;
      throw e;
    }
  }
  throw Errors.conflict("Could not assign a policy version, please retry");
}

export async function getLatestPolicy(type: PolicyType): Promise<Policy | undefined> {
  const db = await getDb();
  const [row] = await db.select().from(policies)
    .where(eq(policies.type, type))
    .orderBy(desc(policies.version))
    .limit(1);
  return row;
}

export interface PolicyOverview {
  type: PolicyType;
  latest: Policy | null;
  versionCount: number;
}

export async function policyOverview(): Promise<PolicyOverview[]> {
  const db = await getDb();
  const types: PolicyType[] = ["rental_terms", "cancellation", "privacy"];
  return Promise.all(types.map(async (type) => {
    const latest = await getLatestPolicy(type);
    const counts = await db.select({ n: sql<number>`count(*)` }).from(policies).where(eq(policies.type, type));
    return { type, latest: latest ?? null, versionCount: Number(counts[0]?.n ?? 0) };
  }));
}

export async function getPolicyVersion(type: PolicyType, version: number): Promise<Policy | undefined> {
  const db = await getDb();
  const [row] = await db.select().from(policies)
    .where(and(eq(policies.type, type), eq(policies.version, version)));
  return row;
}
