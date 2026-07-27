import { describe, it, expect } from "vitest";
import {
  loginCodeEmail, bookingConfirmedEmail, bookingCancelledEmail, adminNewBookingEmail, adminPaymentEmail,
} from "@/lib/email/templates";
import { atAruba, formatDateTime } from "@/lib/time/format";

const startAt = atAruba("2026-07-01", "09:00");
const endAt = atAruba("2026-07-08", "09:00");

const all = [
  loginCodeEmail({ code: "482917", link: "https://x/verify?code=482917" }),
  bookingConfirmedEmail({ vehicleName: "Hyundai Creta", startAt, endAt, rentalTotalCents: 34800, amountPaidCents: 4000, chargeType: "rental_deposit", currency: "USD" }),
  bookingCancelledEmail({ vehicleName: "Kia Picanto", startAt, endAt: atAruba("2026-07-05", "09:00") }),
  adminNewBookingEmail({ vehicleName: "Kia Sportage", startAt, endAt, customerEmail: "a@b.com", paymentOption: "deposit" }),
  adminPaymentEmail({ vehicleName: "Kia Sportage", startAt, endAt, amountCents: 4000, currency: "USD", customerEmail: "a@b.com" }),
];

describe("email templates", () => {
  it("set a subject and render the key facts", () => {
    expect(loginCodeEmail({ code: "482917", link: "https://x" }).html).toContain("482917");
    const conf = bookingConfirmedEmail({ vehicleName: "Hyundai Creta", startAt, endAt: atAruba("2026-07-08", "09:00"), rentalTotalCents: 34800, amountPaidCents: 4000, chargeType: "rental_deposit", currency: "USD" }).html;
    expect(conf).toContain("USD 40.00");   // what they actually paid (reservation fee)
    expect(conf).toContain("USD 348.00");  // rental total, clearly labelled
    expect(adminPaymentEmail({ vehicleName: "X", startAt, endAt, amountCents: 4000, currency: "USD", customerEmail: "a@b.com" }).subject).toContain("USD 40.00");
  });

  it("all have a non-empty subject and html", () => {
    for (const e of all) {
      expect(e.subject.length).toBeGreaterThan(0);
      expect(e.html.length).toBeGreaterThan(0);
    }
  });

  it("render the rental period as human wall time via formatDateTime, never raw ISO", () => {
    const period = `${formatDateTime(startAt)} to ${formatDateTime(endAt)}`;

    const confirmed = bookingConfirmedEmail({ vehicleName: "Hyundai Creta", startAt, endAt, rentalTotalCents: 34800, amountPaidCents: 4000, chargeType: "rental_deposit", currency: "USD" });
    expect(confirmed.html).toContain(period);
    expect(confirmed.html).not.toContain(startAt);

    const cancelled = bookingCancelledEmail({ vehicleName: "Kia Picanto", startAt, endAt });
    expect(cancelled.html).toContain(period);
    expect(cancelled.html).not.toContain(startAt);

    const adminNew = adminNewBookingEmail({ vehicleName: "Kia Sportage", startAt, endAt, customerEmail: "a@b.com", paymentOption: "deposit" });
    expect(adminNew.html).toContain(period);
    expect(adminNew.subject).toContain(formatDateTime(startAt));
    expect(adminNew.html).not.toContain(startAt);

    const adminPay = adminPaymentEmail({ vehicleName: "Kia Sportage", startAt, endAt, amountCents: 4000, currency: "USD", customerEmail: "a@b.com" });
    expect(adminPay.html).toContain(period);
    expect(adminPay.html).not.toContain(startAt);
  });

  it("contain no em-dashes (house writing rule)", () => {
    for (const e of all) {
      expect(e.subject).not.toContain("—");
      expect(e.html).not.toContain("—");
      expect(e.subject).not.toContain("--");
    }
  });
});
