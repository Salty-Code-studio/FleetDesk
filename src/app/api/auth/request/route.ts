import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { env, isProd } from "@/env";
import { issueLoginToken } from "@/lib/auth/customer-login";
import { sendAndLog } from "@/lib/email/send";
import { loginCodeEmail } from "@/lib/email/templates";

export const runtime = "nodejs";

const BodySchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict();

/**
 * POST /api/auth/request — start passwordless login. Strict rate limit (auth
 * tier) per IP, plus per-email scoping, to resist email-bombing/enumeration.
 * Always returns a generic 200 (never reveals whether the email is known).
 */
export const POST = withRoute(async (req) => {
  await enforceRateLimit(req, "auth", "login-request");
  const { email } = await parseJsonBody(req, BodySchema);
  await enforceRateLimit(req, "auth", `login-request:${email}`);

  const { code } = await issueLoginToken(email);
  // Code travels in the URL FRAGMENT (#), which browsers never send to the
  // server or leak via Referer — so the login secret stays out of access logs.
  const link = `${env.APP_ORIGIN}/account/verify#email=${encodeURIComponent(email)}&code=${code}`;
  await sendAndLog({ to: email, type: "login_code", ...loginCodeEmail({ code, link }) });

  // Dev/preview affordance ONLY: with no email provider configured and not in
  // production, return the code so local testing works without Resend. This is
  // doubly gated and never fires in production or once a Resend key is set.
  const devCode = !isProd && !env.RESEND_API_KEY ? code : undefined;
  return json({ ok: true, ...(devCode ? { devCode } : {}) }, req);
});
