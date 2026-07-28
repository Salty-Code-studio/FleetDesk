import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, settings } from "@/lib/db/schema";
import { atAruba } from "@/lib/time/format";
import { POST } from "@/app/api/quote/route";

/**
 * The step 7 payment cards + policy box (book/page.tsx) need the cancellation
 * window and the vehicle's security deposit alongside the price breakdown, so
 * the customer-facing copy can never drift from what settings/the vehicle
 * actually say. This guards /api/quote's response shape: policy sits next to
 * the breakdown, sourced from the same settings + vehicle rows already loaded
 * for the quote itself.
 */
let vehicleSlug = "";

function post(body: unknown) {
  const req = new Request("http://localhost:3000/api/quote", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "quote-policy-meta-test",
    },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({}) });
}

beforeAll(async () => {
  const db = await getDb();
  await runMigrations();
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
  const [v] = await db.insert(vehicles).values({
    slug: "policy-meta-car", plate: "PM-1", class: "SUV", name: "Policy Meta Car", seats: 5,
    transmission: "Automatic", doors: 5, priceDayCents: 5800, priceWeekCents: 34800, priceMonthCents: 118000,
    depositCents: 25000,
  }).returning();
  vehicleSlug = v!.slug;
});

describe("POST /api/quote — policy meta", () => {
  it("returns cancellationWindowHours and the vehicle's securityDepositCents next to the breakdown", async () => {
    const start = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10);
    const res = await post({
      vehicleSlug,
      startAt: atAruba(start, "09:00"),
      endAt: atAruba(end, "09:00"),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy.cancellationWindowHours).toBe(48);
    expect(body.policy.securityDepositCents).toBe(25000);
    // still a real breakdown, not a replacement of it
    expect(body.subtotalCents).toBeGreaterThan(0);
  });
});
