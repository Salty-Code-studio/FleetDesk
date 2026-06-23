import { NextResponse } from "next/server";
import { corsHeaders } from "@/lib/http/cors";

/**
 * Build a JSON success response with CORS headers merged in.
 * Security headers are added globally by middleware, so we don't duplicate them
 * here (single source of truth).
 */
export function json<T>(
  data: T,
  req: Request,
  init?: { status?: number; headers?: Record<string, string> },
): NextResponse {
  const origin = req.headers.get("origin");
  const headers = { ...corsHeaders(origin), ...(init?.headers ?? {}) };
  return NextResponse.json(data, { status: init?.status ?? 200, headers });
}

/** No-content success (e.g. logout). */
export function noContent(req: Request, headers?: Record<string, string>): NextResponse {
  const origin = req.headers.get("origin");
  const merged = { ...corsHeaders(origin), ...(headers ?? {}) };
  return new NextResponse(null, { status: 204, headers: merged });
}
