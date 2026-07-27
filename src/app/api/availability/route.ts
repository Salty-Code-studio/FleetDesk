import { z } from "zod";
import { eq } from "drizzle-orm";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams } from "@/lib/http/validate";
import { Errors } from "@/lib/http/errors";
import { enforceRateLimit } from "@/lib/http/rate-limit";
import { getDb } from "@/lib/db/client";
import { vehicles } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";
import { checkAvailability } from "@/lib/booking/availability";
import { normalizeTs } from "@/lib/booking/public";
import { isoDateTime } from "@/lib/validation/iso-date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  vehicle: z.string().trim().min(1).max(80),
  pickup: z.string().transform(normalizeTs).pipe(isoDateTime),
  return: z.string().transform(normalizeTs).pipe(isoDateTime),
});

/** GET /api/availability?vehicle=slug&pickup&return */
export const GET = withRoute(async (req) => {
  await enforceRateLimit(req, "global", "public");
  const url = new URL(req.url);
  const q = parseParams(Object.fromEntries(url.searchParams), QuerySchema);
  const db = await getDb();
  const [vehicle] = await db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.slug, q.vehicle));
  if (!vehicle) throw Errors.notFound("Vehicle not found");
  const settings = await getSettings();
  return json(await checkAvailability(vehicle.id, q.pickup, q.return, settings), req);
});
