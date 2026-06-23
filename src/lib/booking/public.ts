/**
 * Public, customer-facing read + quote helpers. Active records only, trimmed to
 * what the booking flow needs — no internal fields, no PII.
 */
import { eq, asc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { vehicles, insuranceTiers, addOns } from "@/lib/db/schema";
import { getSettings } from "@/lib/admin/settings";
import { getLatestPolicy, type PolicyType } from "@/lib/admin/policies";
import { rentalDays, quote, type QuoteBreakdown } from "@/lib/booking/quote";
import { validateDates } from "@/lib/booking/availability";
import { Errors } from "@/lib/http/errors";

/** Rental start in Aruba local time (UTC-4), as YYYY-MM-DD. */
export function arubaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Aruba" }).format(new Date());
}

export interface PublicVehicle {
  slug: string; class: string; name: string; seats: number;
  transmission: string; ac: boolean; doors: number; photos: string[];
  priceDayCents: number; priceWeekCents: number; priceMonthCents: number; depositCents: number | null;
}

export async function publicVehicles(): Promise<PublicVehicle[]> {
  const db = await getDb();
  const rows = await db.select().from(vehicles).where(eq(vehicles.status, "active")).orderBy(asc(vehicles.class), asc(vehicles.priceDayCents));
  return rows.map((v) => ({
    slug: v.slug, class: v.class, name: v.name, seats: v.seats, transmission: v.transmission,
    ac: v.ac, doors: v.doors, photos: v.photos, priceDayCents: v.priceDayCents,
    priceWeekCents: v.priceWeekCents, priceMonthCents: v.priceMonthCents, depositCents: v.depositCents,
  }));
}

export async function publicInsurance() {
  const db = await getDb();
  const rows = await db.select().from(insuranceTiers).where(eq(insuranceTiers.active, true)).orderBy(asc(insuranceTiers.dailyPriceCents));
  return rows.map((t) => ({ id: t.id, name: t.name, dailyPriceCents: t.dailyPriceCents, coverage: t.coverage, isDefault: t.isDefault }));
}

export async function publicAddOns() {
  const db = await getDb();
  const rows = await db.select().from(addOns).where(eq(addOns.active, true)).orderBy(asc(addOns.category), asc(addOns.name));
  return rows.map((a) => ({ id: a.id, name: a.name, description: a.description, priceCents: a.priceCents, pricing: a.pricing, category: a.category }));
}

export async function publicPolicy(type: PolicyType) {
  const latest = await getLatestPolicy(type);
  if (!latest) return null;
  return { type, version: latest.version, body: latest.body, publishedAt: latest.publishedAt };
}

export interface QuoteRequest {
  vehicleSlug: string;
  startDate: string;
  endDate: string;
  insuranceTierId?: string | null;
  addOns?: Array<{ addOnId: string; qty: number }>;
}

/** Validate + price a request without creating anything. Throws 4xx on bad input. */
export async function publicQuote(req: QuoteRequest, today: string): Promise<QuoteBreakdown> {
  const db = await getDb();
  const settings = await getSettings();
  const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.slug, req.vehicleSlug));
  if (!vehicle || vehicle.status !== "active") throw Errors.notFound("Vehicle not available");
  validateDates(req.startDate, req.endDate, settings, today);

  let insurance: { id: string; name: string; dailyPriceCents: number } | null = null;
  if (req.insuranceTierId) {
    const [tier] = await db.select().from(insuranceTiers).where(eq(insuranceTiers.id, req.insuranceTierId));
    if (tier && tier.active) insurance = { id: tier.id, name: tier.name, dailyPriceCents: tier.dailyPriceCents };
  }

  const reqAddOns = req.addOns ?? [];
  const addOnRows = reqAddOns.length
    ? await db.select().from(addOns).where(eq(addOns.active, true))
    : [];
  const byId = new Map(addOnRows.map((a) => [a.id, a]));

  return quote({
    days: rentalDays(req.startDate, req.endDate),
    vehicle: {
      priceDayCents: vehicle.priceDayCents, priceWeekCents: vehicle.priceWeekCents,
      priceMonthCents: vehicle.priceMonthCents, depositCents: vehicle.depositCents,
    },
    insurance,
    addOns: reqAddOns.flatMap((r) => {
      const a = byId.get(r.addOnId);
      return a ? [{ id: a.id, name: a.name, priceCents: a.priceCents, pricing: a.pricing, qty: r.qty }] : [];
    }),
    reservationFeeCents: settings.reservationFeeCents,
    currency: settings.currency,
  });
}
