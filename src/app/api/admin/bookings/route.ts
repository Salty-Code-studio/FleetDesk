import { z } from "zod";
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { createManualBooking, ManualBookingSchema } from "@/lib/admin/manual-booking";
import { mapLegacyDateKeys } from "@/lib/booking/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Legacy-key compat: the board UI still sends startDate/endDate until Task 5.
const BodySchema = z.preprocess(mapLegacyDateKeys, ManualBookingSchema);

export const POST = withRoute(async (req) => {
  const input = await parseJsonBody(req, BodySchema);
  const booking = await mutate(req, "admin.manual_booking_created", async () => {
    const row = await createManualBooking(input);
    return {
      result: row, entity: "booking", entityId: row.id,
      after: { source: "manual", vehicleId: row.vehicleId, startAt: row.startAt, endAt: row.endAt },
    };
  });
  return json({ id: booking.id }, req, { status: 201 });
});
