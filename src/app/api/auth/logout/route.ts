import { cookies } from "next/headers";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { requireCustomer } from "@/lib/auth/customer-auth";
import { destroySession } from "@/lib/auth/sessions";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { clearSessionCookies } from "@/lib/auth/session-cookies";

export const runtime = "nodejs";

export const POST = withRoute(async (req) => {
  await requireCustomer(req); // CSRF-checked
  const cookieStore = await cookies();
  await destroySession(cookieStore.get(SESSION_COOKIE)?.value);
  return clearSessionCookies(json({ ok: true }, req));
});
