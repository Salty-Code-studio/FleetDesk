/**
 * Transactional email templates (spec §9). Brand-aligned, plain, warm, and
 * dash-free (house writing rule). Pure functions → unit-testable.
 */
import { formatDateTime } from "@/lib/time/format";

export interface RenderedEmail {
  subject: string;
  html: string;
}

const BRAND = "#2348c7";
const INK = "#15192f";

function shell(title: string, body: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Inter,sans-serif;color:${INK};max-width:520px;margin:0 auto;padding:24px">
  <div style="font-weight:800;letter-spacing:.03em;font-size:18px;margin-bottom:20px">FLEET<span style="color:#f15f2c">DESK</span></div>
  <h1 style="font-size:20px;margin:0 0 12px">${title}</h1>
  ${body}
  <p style="color:#828aa6;font-size:12px;margin-top:28px">FleetDesk &amp; Leasing, Aruba. We bring the car to you.</p>
</div>`;
}

const money = (cents: number, currency: string) => `${currency} ${(cents / 100).toFixed(2)}`;

export function loginCodeEmail(args: { code: string; link: string }): RenderedEmail {
  return {
    subject: "Your FleetDesk sign-in code",
    html: shell("Sign in to your bookings", `
      <p>Use this code to sign in. It is good for 15 minutes.</p>
      <p style="font-size:30px;font-weight:800;letter-spacing:6px;color:${BRAND};margin:16px 0">${args.code}</p>
      <p>Or just tap this link: <a href="${args.link}" style="color:${BRAND}">Sign in</a></p>
      <p style="color:#828aa6;font-size:13px">If you did not request this, you can ignore this email.</p>`),
  };
}

export function bookingConfirmedEmail(args: {
  vehicleName: string; startAt: string; endAt: string;
  rentalTotalCents: number; currency: string;
  amountPaidCents?: number; chargeType?: "reservation_fee" | "deposit";
}): RenderedEmail {
  const paidLine = args.amountPaidCents !== undefined
    ? `Paid now: <strong>${money(args.amountPaidCents, args.currency)}</strong> ${args.chargeType === "deposit" ? "(refundable deposit)" : "(reservation fee)"}<br>`
    : "";
  return {
    subject: `Your ${args.vehicleName} booking is confirmed`,
    html: shell("Booking confirmed", `
      <p>Thanks, your payment came through and your car is reserved.</p>
      <p><strong>${args.vehicleName}</strong><br>${formatDateTime(args.startAt)} to ${formatDateTime(args.endAt)}</p>
      <p>${paidLine}Rental total: ${money(args.rentalTotalCents, args.currency)}<br>
      <span style="color:#828aa6;font-size:13px">We settle the balance with you at pickup.</span></p>
      <p>We will reach out on WhatsApp to arrange delivery. See you soon.</p>`),
  };
}

export function bookingCancelledEmail(args: { vehicleName: string; startAt: string; endAt: string }): RenderedEmail {
  return {
    subject: `Your ${args.vehicleName} booking was cancelled`,
    html: shell("Booking cancelled", `
      <p>Your booking for the <strong>${args.vehicleName}</strong> (${formatDateTime(args.startAt)} to ${formatDateTime(args.endAt)}) has been cancelled.</p>
      <p>If a refund applies, our team will sort it out and be in touch.</p>`),
  };
}

export function adminNewBookingEmail(args: { vehicleName: string; startAt: string; endAt: string; customerEmail: string; paymentOption: string }): RenderedEmail {
  return {
    subject: `New booking: ${args.vehicleName} (${formatDateTime(args.startAt)})`,
    html: shell("New booking", `
      <p>A new booking just came in.</p>
      <p><strong>${args.vehicleName}</strong><br>${formatDateTime(args.startAt)} to ${formatDateTime(args.endAt)}<br>Customer ${args.customerEmail}<br>Payment ${args.paymentOption.replace(/_/g, " ")}</p>`),
  };
}

export function adminPaymentEmail(args: { vehicleName: string; startAt: string; endAt: string; amountCents: number; currency: string; customerEmail: string }): RenderedEmail {
  return {
    subject: `Payment received: ${money(args.amountCents, args.currency)}`,
    html: shell("Payment received", `
      <p>Payment confirmed and the booking is now confirmed.</p>
      <p><strong>${args.vehicleName}</strong><br>${formatDateTime(args.startAt)} to ${formatDateTime(args.endAt)}<br>${money(args.amountCents, args.currency)} from ${args.customerEmail}</p>`),
  };
}
