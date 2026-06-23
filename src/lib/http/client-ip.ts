import { env } from "@/env";

/**
 * The client IP, trusting the forwarding headers ONLY when TRUST_PROXY=true
 * (set exclusively behind a proxy/edge that OVERWRITES them). Otherwise these
 * headers are attacker-controlled, so we return null rather than record a
 * forged value. Shared by the rate limiter and the audit trail so the two
 * cannot diverge on what they trust.
 */
export function trustedClientIp(req: Request): string | null {
  if (!env.TRUST_PROXY) return null;
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  if (first) return first;
  const realIp = req.headers.get("x-real-ip")?.trim();
  return realIp || null;
}
