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

  // Local-dev ONLY affordance, OFF by default (fail-closed). The OTP is returned
  // in the response body ONLY when explicitly opted in via AUTH_DEV_RETURN_CODE
  // AND not in production. Otherwise the code travels solely by email + the magic
  // link, never in the API response. Returning it by default (the old behaviour)
  // was a critical account-takeover hole: anyone could request a code for any
  // email, read it from the response, and log in as that customer.
  const devCode = !isProd && env.AUTH_DEV_RETURN_CODE ? code : undefined;
  return json({ ok: true, ...(devCode ? { devCode } : {}) }, req);
});
