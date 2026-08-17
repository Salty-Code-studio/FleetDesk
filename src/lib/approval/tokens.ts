/**
 * Signed single-use tokens for the email Approve/Decline links. Format:
 * "<requestId>.<base64url hmac>". The key is DERIVED from SESSION_SECRET with
 * a fixed context string, so no new secret has to be provisioned; rotating
 * SESSION_SECRET invalidates outstanding links, which is acceptable (7-day
 * expiry, reminders re-issue nothing; the admin can always decide directly).
 * Only the sha256 of the token is stored (tokenHash), never the token.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/env";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function key(): Buffer {
  return createHmac("sha256", env.SESSION_SECRET).update("fleetdesk-approval-tokens-v1").digest();
}

export function issueApprovalToken(requestId: string): string {
  const mac = createHmac("sha256", key()).update(requestId).digest("base64url");
  return `${requestId}.${mac}`;
}

export function verifyApprovalToken(token: string): string | null {
  const dot = token.indexOf(".");
  if (dot !== 36) return null;
  const requestId = token.slice(0, dot);
  if (!UUID_RE.test(requestId)) return null;
  let mac: Buffer;
  try {
    mac = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", key()).update(requestId).digest();
  if (mac.length !== expected.length) return null;
  return timingSafeEqual(mac, expected) ? requestId : null;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
