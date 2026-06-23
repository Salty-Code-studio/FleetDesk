import type { z } from "zod";
import { Errors, AppError } from "@/lib/http/errors";

/**
 * Validate untrusted input at the trust boundary (NEVER trust the client).
 *
 * - Parses JSON defensively (rejects malformed bodies as 400, not 500).
 * - Runs a zod schema; on failure throws a 422 with FIELD-LEVEL, safe messages.
 * - Returns the parsed, strongly-typed, sanitized value. Downstream code only
 *   ever sees data that matched the schema.
 *
 * OWASP: A03:2021 (Injection) is mitigated upstream by validating shape/format
 * here and using parameterized queries in the data layer.
 */

const MAX_BODY_BYTES = 1_000_000; // 1 MB hard cap — reject oversized payloads early.

function formatZodIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((i) => ({
    path: i.path.join(".") || "(root)",
    message: i.message,
  }));
}

/**
 * Read the body while ENFORCING the byte cap mid-stream. We cannot trust
 * Content-Length: it may be absent (Transfer-Encoding: chunked) or a lie. Buffer
 * via req.text() and the whole (possibly multi-GB) payload lands in memory before
 * any size check runs. Instead, stream and abort the moment the running byte
 * total crosses the cap, so an attacker can never make us allocate past it.
 */
async function readBodyCapped(req: Request, maxBytes: number): Promise<string> {
  const body = req.body;
  if (!body) {
    // No readable stream on this request (rare). Fall back, but still cap.
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw Errors.badRequest("Request body too large");
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw Errors.badRequest("Request body too large");
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw Errors.badRequest("Could not read request body");
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse + validate a JSON request body. Throws AppError on any problem. */
export async function parseJsonBody<S extends z.ZodTypeAny>(
  req: Request,
  schema: S,
): Promise<z.infer<S>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw Errors.badRequest("Content-Type must be application/json");
  }

  // Enforce a size limit defensively even if the platform also does. A declared
  // Content-Length lets us reject early, but it is advisory only: a present value
  // must be a sane number, and we ALWAYS enforce the real cap while streaming
  // (covers chunked / absent / lying Content-Length).
  const lengthHeader = req.headers.get("content-length");
  if (lengthHeader !== null) {
    const declared = Number(lengthHeader);
    if (!Number.isFinite(declared) || declared < 0) {
      throw Errors.badRequest("Invalid Content-Length");
    }
    if (declared > MAX_BODY_BYTES) {
      throw Errors.badRequest("Request body too large");
    }
  }

  const raw = await readBodyCapped(req, MAX_BODY_BYTES);

  let json: unknown;
  try {
    json = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    throw Errors.badRequest("Request body is not valid JSON");
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    throw Errors.validation(formatZodIssues(result.error));
  }
  return result.data;
}

/** Validate URL search params or a route-params object. */
export function parseParams<S extends z.ZodTypeAny>(input: unknown, schema: S): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw Errors.validation(formatZodIssues(result.error));
  }
  return result.data;
}
