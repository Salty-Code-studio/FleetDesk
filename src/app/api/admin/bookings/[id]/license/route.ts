import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseParams, parseJsonBody } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { LicenseSchema } from "@/lib/booking/license";
import { saveBookingLicense } from "@/lib/admin/booking-license";
import { arubaNowIso } from "@/lib/time/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

/** PUT /api/admin/bookings/:id/license — the desk captures the driver's
 *  licence at check-in. Staff opt-in: staff run the handover. The audit row
 *  never carries the licence number or date of birth. */
export const PUT = withRoute(async (req, { params }) => {
  const { id } = parseParams(await params, ParamsSchema);
  const license = await parseJsonBody(req, LicenseSchema);
  const result = await mutate(req, "admin.license_saved", async () => ({
    result: await saveBookingLicense(id, license, arubaNowIso()),
    entity: "booking",
    entityId: id,
    after: { issuingCountry: license.issuingCountry, expiryDate: license.expiryDate },
  }), { roles: ["owner", "staff"] });
  return json(result, req);
});
