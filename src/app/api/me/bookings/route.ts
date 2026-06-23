import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { requireCustomer } from "@/lib/auth/customer-auth";
import { listCustomerBookings } from "@/lib/booking/customer-bookings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/me/bookings — the signed-in customer's own bookings. */
export const GET = withRoute(async (req) => {
  const { customer } = await requireCustomer(req);
  return json(await listCustomerBookings(customer.id), req);
});
