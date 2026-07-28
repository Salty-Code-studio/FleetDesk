import { Errors } from "@/lib/http/errors";

/** A stored-object driver. Implemented by ./local (dev/test) and ./supabase (prod). */
export interface StorageDriver {
  putObject(key: string, data: Uint8Array, contentType: string): Promise<void>;
  getObject(key: string): Promise<{ data: Uint8Array; contentType: string }>;
  getSignedUrl(key: string, ttlSeconds: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

const SAFE_KEY = /^[a-z0-9][a-z0-9/_.-]*$/i;

/**
 * Reject traversal, absolute, and malformed keys BEFORE they reach any
 * filesystem path or storage API. Every facade function calls this, so no
 * driver can ever see a hostile key (defense-in-depth against path traversal).
 */
export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes("..") || key.includes("//") || key.length > 300) {
    throw Errors.badRequest("Invalid storage key");
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** Content type from the key's extension (the local driver stores no metadata). */
export function contentTypeForKey(key: string): string {
  const dot = key.lastIndexOf(".");
  return (dot >= 0 ? CONTENT_TYPES[key.slice(dot).toLowerCase()] : undefined) ?? "application/octet-stream";
}

/**
 * True ONLY when a getObject() failure means the object genuinely does not
 * exist -- Node's ENOENT from the local driver, or Supabase's semantic 404
 * (surfaced as `statusCode: "404"` on the underlying StorageApiError, which
 * the Supabase driver preserves as `cause`) -- as opposed to a real outage
 * (5xx, network fault, a rotated/invalid service-role key, an
 * assertSafeKey() badRequest). Callers must let anything else propagate
 * unchanged so it surfaces as a 500 (or its own AppError status) and logs at
 * error level, instead of a benign 404 that hides a real incident.
 */
export function isObjectNotFoundError(e: unknown): boolean {
  if (e && typeof e === "object" && (e as { code?: unknown }).code === "ENOENT") return true;
  const cause = e && typeof e === "object" ? (e as { cause?: unknown }).cause : undefined;
  return !!cause && typeof cause === "object" && (cause as { statusCode?: unknown }).statusCode === "404";
}
