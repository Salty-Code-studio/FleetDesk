import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { parseJsonBody } from "@/lib/http/validate";
import { mutate } from "@/lib/admin/guard";
import { createManualBooking, ManualBookingSchema } from "@/lib/admin/manual-booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withRoute(async (req) => {
  const input = await parseJsonBody(req, ManualBookingSchema);
  const booking = await mutate(req, "admin.manual_booking_created", async () => {
    const row = await createManualBooking(input);
    return {
      result: row, entity: "booking", entityId: row.id,
      after: { source: "manual", vehicleId: row.vehicleId, startDate: row.startDate, endDate: row.endDate },
    };
  });
  return json({ id: booking.id }, req, { status: 201 });
});
