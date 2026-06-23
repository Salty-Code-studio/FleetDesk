import { env } from "@/env";

/**
 * Strict, allowlist-based CORS — DENY BY DEFAULT.
 *
 * Security rationale:
 *   - We NEVER reflect an arbitrary Origin and we NEVER use the wildcard `*`
 *     together with credentials (the browser forbids it, and it would defeat
 *     same-origin protections anyway).
 *   - Only EXACT origins from CORS_ALLOWED_ORIGINS get CORS headers.
 *   - `Vary: Origin` is set so caches don't serve a response for the wrong origin.
 *   - Preflight (OPTIONS) is answered explicitly with a tight method/header set.
 *
 * NOTE: CORS protects browsers from reading cross-origin responses; it is NOT an
 * authentication or authorization mechanism. Server-side authz (see authz.ts)
 * is still mandatory. CSRF for the cookie path is handled separately (csrf.ts).
 */

const ALLOWED = new Set(env.CORS_ALLOWED_ORIGINS);

const ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const ALLOWED_HEADERS = "Content-Type,Authorization,X-CSRF-Token";
const MAX_AGE = "600"; // seconds the browser may cache the preflight result

export function isAllowedOrigin(origin: string | null): origin is string {
  return origin !== null && ALLOWED.has(origin);
}

/** Headers to merge into a normal (non-preflight) response. */
export function corsHeaders(origin: string | null): Record<string, string> {
  // Always set Vary so shared caches key on Origin.
  const headers: Record<string, string> = { Vary: "Origin" };
  if (isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Access-Control-Expose-Headers"] = "X-RateLimit-Remaining,X-RateLimit-Reset";
  }
  return headers;
}

/** Build a preflight (OPTIONS) Response. Denied origins get a bare 204 (no ACAO). */
export function preflightResponse(req: Request): Response {
  const origin = req.headers.get("origin");
  const headers = new Headers({ Vary: "Origin" });
  if (isAllowedOrigin(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
    headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    headers.set("Access-Control-Max-Age", MAX_AGE);
  }
  // 204 with no body. Disallowed origins simply receive no ACAO header and the
  // browser blocks the request.
  return new Response(null, { status: 204, headers });
}
