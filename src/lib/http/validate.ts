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
 * Read the body as raw bytes while ENFORCING the byte cap mid-stream. We
 * cannot trust Content-Length: it may be absent (Transfer-Encoding: chunked)
 * or a lie. Buffer via req.arrayBuffer()/req.text() and the whole (possibly
 * multi-GB) payload lands in memory before any size check runs. Instead,
 * stream and abort the moment the running byte total crosses the cap, so an
 * attacker can never make us allocate past it.
 *
 * Shared low-level primitive behind readBodyCapped (JSON, decodes the result
 * to utf8 text) and parseMultipartCapped (multipart, hands the raw bytes to
 * Response#formData() so binary file data is never corrupted by a text
 * round-trip).
 */
async function readBodyCappedBytes(req: Request, maxBytes: number): Promise<Buffer> {
  const body = req.body;
  if (!body) {
    // No readable stream on this request (rare). Fall back, but still cap.
    const buf = Buffer.from(await req.arrayBuffer());
    if (buf.byteLength > maxBytes) throw Errors.badRequest("Request body too large");
    return buf;
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
  return Buffer.concat(chunks);
}

/** Text-decoding wrapper around readBodyCappedBytes for the JSON path. */
async function readBodyCapped(req: Request, maxBytes: number): Promise<string> {
  return (await readBodyCappedBytes(req, maxBytes)).toString("utf8");
}

/**
 * Cheap, header-only pre-check: reject a request whose DECLARED Content-Length
 * exceeds maxBytes, before any code reads the body. A present Content-Length
 * is advisory only — a client can omit it, or lie under chunked transfer — so
 * this is only a fast-path rejection for the honest/common case, NEVER the
 * sole defense: every caller must pair it with mid-stream enforcement
 * (readBodyCapped for JSON, parseMultipartCapped for multipart, both below)
 * that also catches an absent, chunked, or lying Content-Length.
 */
export function assertContentLengthWithinCap(req: Request, maxBytes: number): void {
  const lengthHeader = req.headers.get("content-length");
  if (lengthHeader === null) return; // absent (e.g. chunked transfer) — nothing to check up front
  const declared = Number(lengthHeader);
  if (!Number.isFinite(declared) || declared < 0) {
    throw Errors.badRequest("Invalid Content-Length");
  }
  if (declared > maxBytes) {
    throw Errors.badRequest("Request body too large");
  }
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
  // Content-Length lets us reject early, but it is advisory only, so we ALWAYS
  // ALSO enforce the real cap while streaming (covers chunked / absent /
  // lying Content-Length) via readBodyCapped below.
  assertContentLengthWithinCap(req, MAX_BODY_BYTES);

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

/**
 * Parse a multipart/form-data body while ENFORCING the byte cap mid-stream —
 * mirrors readBodyCapped's protection for the JSON path. req.formData() has
 * no hook to enforce a cap while it internally buffers/parses the body, so
 * instead we read the raw bytes ourselves with the cap enforced
 * (readBodyCappedBytes, above), then hand that already-capped buffer to
 * Response#formData() to do the actual multipart parsing. This closes the
 * gap assertContentLengthWithinCap alone cannot: a request with an absent,
 * chunked, or lying Content-Length can no longer make us buffer past
 * maxBytes before any check runs.
 */
export async function parseMultipartCapped(req: Request, maxBytes: number): Promise<FormData> {
  const contentType = req.headers.get("content-type") ?? "";
  const bytes = await readBodyCappedBytes(req, maxBytes);
  try {
    return await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw Errors.badRequest("Expected multipart form data");
  }
}

/** Validate URL search params or a route-params object. */
export function parseParams<S extends z.ZodTypeAny>(input: unknown, schema: S): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw Errors.validation(formatZodIssues(result.error));
  }
  return result.data;
}
