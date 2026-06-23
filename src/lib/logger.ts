import { env } from "@/env";

/**
 * Structured JSON logger — secret-safe by construction.
 *
 * Security rationale (OWASP A09:2021 — Security Logging & Monitoring Failures):
 *   - Emits one JSON object per line so logs are machine-parseable by a SIEM.
 *   - Redacts a denylist of sensitive keys at any depth before serialization,
 *     so a careless `logger.info("x", { password })` cannot leak a credential.
 *   - Never logs raw request bodies or `authorization`/`cookie` headers.
 *   - Respects LOG_LEVEL so debug noise is off in production by default.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVEL_WEIGHT[env.LOG_LEVEL];

/** Keys whose values are scrubbed regardless of nesting depth. */
const SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|cookie|set-cookie|jwt|refresh|csrf|api[-_]?key|session|hash|salt)/i;

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;

function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (seen.has(value as object)) return "[CIRCULAR]";
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));

  if (value instanceof Error) {
    // Log the message + name, never attach arbitrary error props that may carry data.
    return { name: value.name, message: value.message };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  if (LEVEL_WEIGHT[level] < threshold) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(context ? { ctx: redact(context) as Record<string, unknown> } : {}),
  };
  const line = JSON.stringify(record);
  // Route warn/error to stderr, the rest to stdout — standard 12-factor behavior.
  if (level === "error" || level === "warn") {
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => emit("debug", msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit("error", msg, ctx),
};
