import { z } from "zod";
import { eq } from "drizzle-orm";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { Errors } from "@/lib/http/errors";
import { getDb } from "@/lib/db/client";
import { customers } from "@/lib/db/schema";
import { verifyLoginToken } from "@/lib/auth/customer-login";
import { createSession } from "@/lib/auth/sessions";
import { applySessionCookies } from "@/lib/auth/session-cookies";
import { trustedClientIp } from "@/lib/http/client-ip";

export const runtime = "nodejs";

const BodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  code: z.string().trim().regex(/^\d{6}$/),
}).strict();

/**
 * POST /api/auth/verify — complete passwordless login. On a valid OTP we upsert
 * the customer (email now verified) and issue a customer session.
 */
export const POST = withRoute(async (req) => {
  await enforceRateLimit(req, "auth", "login-verify");
  const { email, code } = await parseJsonBody(req, BodySchema);

  const result = await verifyLoginToken(email, code);
  if (!result.ok) throw Errors.unauthorized("That code is invalid or has expired");

  const db = await getDb();
  await db.insert(customers).values({ email, emailVerified: true }).onConflictDoUpdate({
    target: customers.email,
    set: { emailVerified: true },
  });
  const [customer] = await db.select().from(customers).where(eq(customers.email, email));

  const created = await createSession({
    subjectType: "customer",
    subjectId: customer!.id,
    ip: trustedClientIp(req),
    ua: req.headers.get("user-agent"),
  });
  return applySessionCookies(json({ ok: true }, req), created);
});
