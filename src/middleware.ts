import { NextResponse, type NextRequest } from "next/server";
import { securityHeaders } from "@/lib/http/security-headers";
import { corsHeaders, preflightResponse } from "@/lib/http/cors";

/**
 * Edge middleware — secure headers on EVERY response (API + UI pages).
 *   1. Answer CORS preflight (OPTIONS) immediately.
 *   2. Stamp secure headers: a strict CSP for /api (JSON), a UI CSP for pages.
 *   3. Merge CORS for allowed origins.
 * No auth/crypto here (Edge runtime) — those live in route handlers.
 */
export function middleware(req: NextRequest): NextResponse {
  const origin = req.headers.get("origin");
  const isApi = req.nextUrl.pathname.startsWith("/api");
  const headers = securityHeaders({ ui: !isApi });

  if (req.method === "OPTIONS") {
    const pre = preflightResponse(req);
    const res = new NextResponse(pre.body, { status: pre.status, headers: pre.headers });
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  }

  const res = NextResponse.next();
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.headers.set(k, v);
  return res;
}

export const config = {
  // All routes EXCEPT Next internals + static assets (which need no app headers).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
