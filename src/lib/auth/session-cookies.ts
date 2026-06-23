/** Apply / clear the session + CSRF cookie pair on a response. */
import type { NextResponse } from "next/server";
import { env } from "@/env";
import {
  SESSION_COOKIE, CSRF_COOKIE,
  sessionCookieAttributes, csrfCookieAttributes, clearedAttributes,
} from "@/lib/auth/cookies";
import type { CreatedSession } from "@/lib/auth/sessions";

export function applySessionCookies(res: NextResponse, created: CreatedSession): NextResponse {
  res.cookies.set(SESSION_COOKIE, created.cookieValue, sessionCookieAttributes(env.SESSION_TTL_SECONDS));
  res.cookies.set(CSRF_COOKIE, created.csrfToken, csrfCookieAttributes(env.SESSION_TTL_SECONDS));
  return res;
}

export function clearSessionCookies(res: NextResponse): NextResponse {
  res.cookies.set(SESSION_COOKIE, "", clearedAttributes(sessionCookieAttributes(0)));
  res.cookies.set(CSRF_COOKIE, "", clearedAttributes(csrfCookieAttributes(0)));
  return res;
}
