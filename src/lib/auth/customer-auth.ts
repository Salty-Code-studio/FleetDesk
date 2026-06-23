/**
 * Customer route guard — the passwordless mirror of requireAdmin. A live
 * session whose subjectType is 'customer', CSRF-checked on unsafe methods. No
 * password, no MFA. The session subjectId is the customers.id.
 */
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { customers } from "@/lib/db/schema";
import { resolveSession, type SessionRecord } from "@/lib/auth/sessions";
import { enforceCsrf } from "@/lib/auth/csrf";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { Errors } from "@/lib/http/errors";

export type Customer = typeof customers.$inferSelect;

export interface CustomerContext {
  customer: Customer;
  session: SessionRecord;
}

export async function requireCustomer(req: Request): Promise<CustomerContext> {
  const cookieStore = await cookies();
  const session = await resolveSession(cookieStore.get(SESSION_COOKIE)?.value);
  if (!session || session.subjectType !== "customer") throw Errors.unauthorized();

  await enforceCsrf(req, session);

  const db = await getDb();
  const [customer] = await db.select().from(customers).where(eq(customers.id, session.subjectId));
  if (!customer) throw Errors.unauthorized("Account no longer exists");
  return { customer, session };
}
