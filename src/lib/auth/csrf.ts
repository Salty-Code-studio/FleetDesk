import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { SessionRecord } from "@/lib/auth/sessions";
import { CSRF_COOKIE } from "@/lib/auth/cookies";
import { isAllowedOrigin } from "@/lib/http/cors";
import { Errors } from "@/lib/http/errors";

/**
 * CSRF protection for the COOKIE-AUTH path (double-submit + Origin check).
 *
 * Why (OWASP CSRF Prevention Cheat Sheet):
 *   Cookies are sent automatically by the browser, so a cross-site form/JS can
 *   trigger authenticated state-changing requests. SameSite=Lax already blocks
 *   most of this, but we add two independent checks (defense-in-depth):
 *
 *   1. SYNCHRONIZER/DOUBLE-SUBMIT TOKEN: the per-session CSRF secret is also
 *      stored in a readable cookie. The client must echo it in the `X-CSRF-Token`
 *      header. An attacker on another origin cannot read our cookie (SOP) and so
 *      cannot set the matching header. We compare the header against the value
 *      bound to the SERVER-SIDE session (authoritative), constant-time.
 *
 *   2. ORIGIN/REFERER allowlist: state-changing requests must originate from an
 *      allowed origin.
 *
 *   JWT-in-Authorization-header flows are NOT cookie-driven and are immune to
 *   classic CSRF, so this check applies only to the session-cookie endpoints.
 *
 * Only enforced for unsafe methods (POST/PUT/PATCH/DELETE).
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Bare-origin of a URL (scheme + host + port), or null if it can't be parsed.
 * Used to derive an origin from the Referer header when Origin is absent.
 */
function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Defense #2: Origin/Referer allowlist for state-changing requests. Fail-CLOSED:
 * if we cannot positively confirm the request came from an allowed origin, we
 * reject it. A forged cross-site request either carries a disallowed
 * Origin/Referer or (when neither header is present) is rejected. Exported so
 * unauthenticated-but-state-changing guest endpoints (booking create, checkout)
 * can get CSRF protection without a session/double-submit token.
 */
export function enforceOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (origin !== null) {
    if (!isAllowedOrigin(origin)) {
      throw Errors.csrf("Request origin is not allowed");
    }
    return;
  }
  // No Origin header (some same-origin/older clients): fall back to Referer.
  const refererOrigin = originOf(req.headers.get("referer"));
  if (refererOrigin === null || !isAllowedOrigin(refererOrigin)) {
    throw Errors.csrf("Missing or untrusted request origin");
  }
}

/**
 * Enforce CSRF for a cookie-authenticated, state-changing request.
 * Throws a 403 AppError on failure (fail-closed). No-op for safe methods.
 */
export async function enforceCsrf(req: Request, session: SessionRecord): Promise<void> {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return;

  // (2) Origin/Referer allowlist — an independent check from the token so that
  // a single failure (e.g. a leaked token) does not by itself enable CSRF.
  enforceOrigin(req);

  // (1) Double-submit token check against the authoritative session value.
  const headerToken = req.headers.get("x-csrf-token");
  const cookieStore = await cookies();
  const cookieToken = cookieStore.get(CSRF_COOKIE)?.value;

  if (!headerToken || !cookieToken) {
    throw Errors.csrf("Missing CSRF token");
  }
  // Header must match the cookie AND both must match the server session secret.
  if (
    !constantTimeEqual(headerToken, cookieToken) ||
    !constantTimeEqual(headerToken, session.csrfToken)
  ) {
    throw Errors.csrf("Invalid CSRF token");
  }
}
