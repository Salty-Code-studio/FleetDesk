/**
 * Typed application errors + a centralized response builder.
 *
 * Security rationale (OWASP A04/A05 — fail securely, no information leakage):
 *   - Route handlers THROW these typed errors. A single handler
 *     (`toErrorResponse`) converts them to safe JSON. Handlers never build
 *     raw error responses themselves, so we cannot accidentally serialize a
 *     stack trace, SQL string, or internal exception message to the client.
 *   - Unknown/unexpected errors are coerced to a generic 500 with NO detail.
 *   - Every error response carries a correlation `requestId` so the real cause
 *     (logged server-side with full detail) can be found without exposing it.
 */
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { isProd } from "@/env";

export type ErrorCode =
  | "bad_request"
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "csrf_failed"
  | "internal_error";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_error: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  csrf_failed: 403,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  /** HTTP status this code maps to — an own property (not a prototype getter)
   *  so it survives structural matchers like `toMatchObject`. */
  readonly status: number;
  /** Safe, client-facing detail. MUST NOT contain internals. */
  readonly publicMessage: string;
  /** Optional structured field errors (e.g. from zod) — already safe. */
  readonly details?: unknown;
  /** Extra headers to attach (e.g. Retry-After, WWW-Authenticate). */
  readonly headers?: Record<string, string>;

  constructor(
    code: ErrorCode,
    publicMessage: string,
    opts?: { details?: unknown; headers?: Record<string, string>; cause?: unknown },
  ) {
    super(publicMessage, opts?.cause ? { cause: opts.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.publicMessage = publicMessage;
    this.details = opts?.details;
    this.headers = opts?.headers;
  }
}

// Convenience constructors.
export const Errors = {
  badRequest: (msg = "Bad request", details?: unknown) =>
    new AppError("bad_request", msg, { details }),
  validation: (details: unknown, msg = "Request validation failed") =>
    new AppError("validation_error", msg, { details }),
  unauthorized: (msg = "Authentication required") =>
    new AppError("unauthorized", msg, { headers: { "WWW-Authenticate": "Bearer" } }),
  forbidden: (msg = "You do not have access to this resource") => new AppError("forbidden", msg),
  notFound: (msg = "Resource not found") => new AppError("not_found", msg),
  conflict: (msg = "Conflict", details?: unknown) => new AppError("conflict", msg, { details }),
  rateLimited: (retryAfterSeconds: number, msg = "Too many requests") =>
    new AppError("rate_limited", msg, { headers: { "Retry-After": String(retryAfterSeconds) } }),
  csrf: (msg = "CSRF validation failed") => new AppError("csrf_failed", msg),
};

/** Generate a short, non-guessable correlation id. */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Convert ANY thrown value into a safe NextResponse.
 * - AppError -> its code/status/publicMessage (+ safe details).
 * - Anything else -> generic 500, full detail logged server-side only.
 */
export function toErrorResponse(err: unknown, requestId: string): NextResponse {
  if (err instanceof AppError) {
    // Log at a level appropriate to severity; 5xx is error, 4xx is warn/info.
    const status = STATUS[err.code];
    const logFn = status >= 500 ? logger.error : logger.warn;
    logFn("request_failed", {
      requestId,
      code: err.code,
      status,
      // publicMessage is safe to log; cause may contain internals -> logger redacts objects.
      cause: err.cause,
    });
    return NextResponse.json(
      {
        error: { code: err.code, message: err.publicMessage, ...(err.details ? { details: err.details } : {}) },
        requestId,
      },
      { status, headers: err.headers },
    );
  }

  // Unknown error: log everything server-side, reveal nothing client-side.
  logger.error("unhandled_exception", { requestId, error: err });
  return NextResponse.json(
    {
      error: {
        code: "internal_error",
        // In dev we still keep it generic; details live in the logs by design.
        message: isProd ? "An unexpected error occurred." : "An unexpected error occurred (see server logs).",
      },
      requestId,
    },
    { status: 500 },
  );
}
