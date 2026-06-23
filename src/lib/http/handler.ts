import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { newRequestId, toErrorResponse } from "@/lib/http/errors";
import { securityHeaders } from "@/lib/http/security-headers";

/**
 * `withRoute` wraps a route handler with:
 *   - a per-request correlation id,
 *   - structured access logging (no bodies, no secrets),
 *   - a centralized try/catch that converts ANY throw into a safe response,
 *   - a backstop application of security headers (middleware is primary).
 *
 * Handlers therefore focus only on business logic and may freely `throw`
 * AppError / unexpected errors — they will never leak internals to the client.
 */

export type RouteContext<P = Record<string, string>> = { params: Promise<P> };

type Handler<P> = (
  req: Request,
  ctx: { params: P; requestId: string },
) => Promise<NextResponse> | NextResponse;

export function withRoute<P = Record<string, string>>(handler: Handler<P>) {
  // Next 15 type-validates the exact handler signature: the context arg must be
  // declared non-optional (Next always passes one), so we guard at runtime only.
  return async (req: Request, routeCtx: RouteContext<P>): Promise<NextResponse> => {
    const requestId = newRequestId();
    const started = Date.now();
    const url = new URL(req.url);

    let response: NextResponse;
    try {
      const params = routeCtx?.params ? await routeCtx.params : ({} as P);
      response = await handler(req, { params, requestId });
    } catch (err) {
      response = toErrorResponse(err, requestId);
    }

    // Always stamp the correlation id and ensure security headers are present
    // (defense-in-depth: middleware also sets them).
    response.headers.set("X-Request-Id", requestId);
    for (const [k, v] of Object.entries(securityHeaders())) {
      if (!response.headers.has(k)) response.headers.set(k, v);
    }

    logger.info("request", {
      requestId,
      method: req.method,
      path: url.pathname,
      status: response.status,
      durationMs: Date.now() - started,
    });

    return response;
  };
}
