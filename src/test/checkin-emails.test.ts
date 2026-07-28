import { describe, it, expect } from "vitest";
import { bookingPickedUpEmail, bookingReturnSummaryEmail } from "@/lib/email/templates";

const pickedUp = bookingPickedUpEmail({
  vehicleName: "Kia Sportage",
  periodStart: "Aug 1, 2026 at 09:00",
  periodEnd: "Aug 5, 2026 at 09:00",
  balanceDueCents: 0,
  borgReceivedCents: 25000,
  currency: "USD",
});

const returnedClean = bookingReturnSummaryEmail({
  vehicleName: "Kia Sportage",
  returnedAt: "Aug 5, 2026 at 09:30",
  newDamage: false,
  borgReturnedCents: 25000,
  borgWithheldCents: 0,
  borgWithheldReason: null,
  currency: "USD",
});

const returnedDamaged = bookingReturnSummaryEmail({
  vehicleName: "Kia Sportage",
  returnedAt: "Aug 5, 2026 at 09:30",
  newDamage: true,
  borgReturnedCents: 15000,
  borgWithheldCents: 10000,
  borgWithheldReason: "scratch on the left door",
  currency: "USD",
});

describe("check-in/out emails", () => {
  it("pickup email mentions the contract attachment and the borg", () => {
    expect(pickedUp.subject).toContain("Kia Sportage");
    expect(pickedUp.html).toContain("attached");
    expect(pickedUp.html).toContain("USD 250.00");
  });

  it("return summary reflects clean vs damaged returns and borg amounts", () => {
    expect(returnedClean.html).toContain("USD 250.00");
    expect(returnedClean.html).not.toContain("withheld");
    expect(returnedDamaged.html).toContain("USD 100.00");
    expect(returnedDamaged.html).toContain("scratch on the left door");
  });

  it("contains no em-dashes (house writing rule)", () => {
    for (const e of [pickedUp, returnedClean, returnedDamaged]) {
      expect(e.subject).not.toContain("—");
      expect(e.html).not.toContain("—");
      expect(e.subject).not.toContain("--");
    }
  });
});
