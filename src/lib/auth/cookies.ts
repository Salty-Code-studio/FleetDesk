import { env, isProd } from "@/env";

/**
 * Cookie names + secure attribute helpers.
 *
 * Security rationale (OWASP Session Management Cheat Sheet):
 *   - HttpOnly: JS cannot read the cookie -> XSS can't steal the session token.
 *   - Secure: only sent over HTTPS (enabled in production / when APP_ORIGIN is https).
 *   - SameSite=Lax for the session cookie: sent on top-level navigations but NOT
 *     on cross-site subresource/AJAX POSTs — a strong CSRF baseline. We ALSO add
 *     a double-submit CSRF token (csrf.ts) for defense-in-depth.
 *   - __Host- prefix: forces Secure + Path=/ + no Domain, binding the cookie to
 *     the exact host. Browsers reject a __Host- cookie that violates these rules.
 *     We only use the prefix when on HTTPS (it would be rejected on http://localhost).
 */

const secure = isProd || env.APP_ORIGIN.startsWith("https://");

// __Host- prefix requires Secure; fall back to a plain name for local http dev.
export const SESSION_COOKIE = secure ? "__Host-sid" : "sid";
// CSRF cookie is intentionally NOT HttpOnly so the client can echo it in a header.
export const CSRF_COOKIE = secure ? "__Host-csrf" : "csrf";

export interface CookieAttributes {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  path: string;
  maxAge: number;
}

export function sessionCookieAttributes(maxAgeSeconds: number): CookieAttributes {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export function csrfCookieAttributes(maxAgeSeconds: number): CookieAttributes {
  return {
    httpOnly: false, // must be readable by the client to echo back in a header
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** Attributes used to clear a cookie (maxAge 0). */
export function clearedAttributes(base: CookieAttributes): CookieAttributes {
  return { ...base, maxAge: 0 };
}

export const cookiesAreSecure = secure;
