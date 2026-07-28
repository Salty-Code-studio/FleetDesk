import { describe, it, expect, beforeAll } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { patchSettings } from "@/lib/admin/settings";
import { GET } from "@/app/api/booking-config/route";

/**
 * The booking wizard (book/page.tsx) used to hardcode business hours as
 * 08:00-18:00 and had no live updater wired to a real source, so an operator
 * with custom hours would have out-of-hours slots offered by the TimeSelect
 * controls — the quote then fails closed with a "must be between X and Y"
 * 4xx. /api/booking-config is the wizard's one non-quote, pre-selection read
 * of settings, so it must carry the real openingTime/closingTime (not just
 * the driver-age config) for the wizard to initialize its hours correctly
 * BEFORE the customer picks a time.
 */
function get() {
  const req = new Request("http://localhost:3000/api/booking-config", {
    headers: { "user-agent": "booking-config-test" },
  });
  return GET(req, { params: Promise.resolve({}) });
}

beforeAll(async () => {
  await runMigrations();
});

describe("GET /api/booking-config", () => {
  it("returns the operator's actual opening/closing hours, not a hardcoded default", async () => {
    await patchSettings({ openingTime: "07:00", closingTime: "20:00" });
    try {
      const res = await get();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.openingTime).toBe("07:00");
      expect(body.closingTime).toBe("20:00");
    } finally {
      // restore defaults so later files that share the test database see them
      await patchSettings({ openingTime: "08:00", closingTime: "18:00" });
    }
  });

  it("still returns the driver-age config alongside the hours", async () => {
    const res = await get();
    const body = await res.json();
    expect(body.minDriverAge).toBe(18);
    expect(body.youngDriverAge).toBe(21);
    expect(typeof body.youngDriverFeeCentsPerDay).toBe("number");
    expect(body.currency).toBe("USD");
  });
});
