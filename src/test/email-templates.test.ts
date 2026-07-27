import { describe, it, expect } from "vitest";
import {
  loginCodeEmail, bookingConfirmedEmail, bookingCancelledEmail, adminNewBookingEmail, adminPaymentEmail,
} from "@/lib/email/templates";
import { atAruba } from "@/lib/time/format";

const startAt = atAruba("2026-07-01", "09:00");

const all = [
  loginCodeEmail({ code: "482917", link: "https://x/verify?code=482917" }),
  bookingConfirmedEmail({ vehicleName: "Hyundai Creta", startAt, endAt: atAruba("2026-07-08", "09:00"), rentalTotalCents: 34800, amountPaidCents: 4000, chargeType: "reservation_fee", currency: "USD" }),
  bookingCancelledEmail({ vehicleName: "Kia Picanto", startAt, endAt: atAruba("2026-07-05", "09:00") }),
  adminNewBookingEmail({ vehicleName: "Kia Sportage", startAt, endAt: atAruba("2026-07-08", "09:00"), customerEmail: "a@b.com", paymentOption: "reservation_fee" }),
  adminPaymentEmail({ vehicleName: "Kia Sportage", amountCents: 4000, currency: "USD", customerEmail: "a@b.com" }),
];

describe("email templates", () => {
  it("set a subject and render the key facts", () => {
    expect(loginCodeEmail({ code: "482917", link: "https://x" }).html).toContain("482917");
    const conf = bookingConfirmedEmail({ vehicleName: "Hyundai Creta", startAt, endAt: atAruba("2026-07-08", "09:00"), rentalTotalCents: 34800, amountPaidCents: 4000, chargeType: "reservation_fee", currency: "USD" }).html;
    expect(conf).toContain("USD 40.00");   // what they actually paid (reservation fee)
    expect(conf).toContain("USD 348.00");  // rental total, clearly labelled
    expect(adminPaymentEmail({ vehicleName: "X", amountCents: 4000, currency: "USD", customerEmail: "a@b.com" }).subject).toContain("USD 40.00");
  });

  it("all have a non-empty subject and html", () => {
    for (const e of all) {
      expect(e.subject.length).toBeGreaterThan(0);
      expect(e.html.length).toBeGreaterThan(0);
    }
  });

  it("contain no em-dashes (house writing rule)", () => {
    for (const e of all) {
      expect(e.subject).not.toContain("—");
      expect(e.html).not.toContain("—");
      expect(e.subject).not.toContain("--");
    }
  });
});
