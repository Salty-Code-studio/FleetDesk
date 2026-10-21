import { ne, sql } from "drizzle-orm";
import { env } from "@/env";
import { getDb } from "@/lib/db/client";
import { bookings } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";
import { listVehicles } from "@/lib/admin/vehicles";
import { listInsurance, listAddOns } from "@/lib/admin/catalog";
import { policyOverview } from "@/lib/admin/policies";
import { listStaff } from "@/lib/admin/staff";
import { setupProgress, type SetupProgress } from "@/lib/admin/setup-progress";

export async function getSetupProgress(): Promise<SetupProgress> {
  const db = await getDb();
  const [settings, vehicles, tiers, addOns, policies, staff, live] = await Promise.all([
    getSettings(),
    listVehicles(),
    listInsurance(),
    listAddOns(),
    policyOverview(),
    listStaff(),
    db.select({ n: sql<number>`count(*)::int` }).from(bookings).where(ne(bookings.status, "cancelled")),
  ]);
  const cars = vehicles.filter((v) => v.status !== "retired");
  return setupProgress({
    alertRecipients: settings.adminAlertRecipients.length,
    activeCars: cars.length,
    carsWithDayRate: cars.filter((v) => v.priceDayCents != null && v.priceDayCents > 0).length,
    carsWithDeposit: cars.filter((v) => v.depositCents != null && v.depositCents > 0).length,
    activeTiers: tiers.filter((t) => t.active).length,
    activeAddOns: addOns.filter((a) => a.active).length,
    policiesPublished: policies.filter((p) => p.latest !== null).length,
    paymentsReady: env.PAYMENT_MODE === "desk" || Boolean(env.STRIPE_SECRET_KEY),
    activeStaff: staff.filter((s) => s.active).length,
    liveBookings: Number(live[0]?.n ?? 0),
  });
}
