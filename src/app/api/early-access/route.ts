import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { enforceOrigin } from "@/lib/auth/csrf";
import { getDb } from "@/lib/db/client";
import { earlyAccessLeads } from "@/lib/db/schema";

export const runtime = "nodejs";

const BodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  company: z.string().trim().max(160).optional().default(""),
  country: z.string().trim().max(80).optional().default(""),
  // Accept the empty string as "not chosen" so the optional default is valid.
  fleetSize: z.enum(["", "1-5", "6-10", "11-25", "26-50", "50+"]).optional().default(""),
  message: z.string().trim().max(2000).optional().default(""),
  // honeypot: real users never fill this, bots do. Accept any value (capped) so a
  // bot submission validates and we can silently drop it in the handler rather
  // than returning a 422 that signals the trap exists. Default empty for humans.
  website: z.string().max(200).optional().default(""),
}).strict();

/**
 * POST /api/early-access — capture a marketing funnel lead.
 *
 * The honeypot field `website` is invisible to humans. A non-empty value means a
 * bot, so we return the same success shape WITHOUT inserting (do not tip off the
 * bot). Email is stored lowercased. Rate-limited before parsing.
 */
export const POST = withRoute(async (req) => {
  // CSRF: unauthenticated state-changing public POST (writes a lead), so guard
  // with the Origin/Referer allowlist (fail-closed), matching /api/bookings.
  enforceOrigin(req);
  await enforceRateLimit(req, "global", "public");
  const body = await parseJsonBody(req, BodySchema);

  // Honeypot tripped: a real submission never sets `website`. Silently accept.
  if (body.website.length > 0) {
    return json({ ok: true }, req, { status: 201 });
  }

  const db = await getDb();
  await db.insert(earlyAccessLeads).values({
    name: body.name,
    email: body.email.toLowerCase(),
    company: body.company,
    country: body.country,
    fleetSize: body.fleetSize,
    message: body.message,
    source: "early-access",
  });

  return json({ ok: true }, req, { status: 201 });
});
