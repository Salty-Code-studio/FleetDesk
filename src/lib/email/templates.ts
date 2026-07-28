/**
 * Transactional email templates (spec §9). Brand-aligned, plain, warm, and
 * dash-free (house writing rule). Pure functions → unit-testable.
 */
import { formatDateTime } from "@/lib/time/format";
import { siteConfig } from "@/lib/site-config";

export interface RenderedEmail {
  subject: string;
  html: string;
}

const BRAND = "#2348c7";
const INK = "#15192f";

function shell(title: string, body: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Inter,sans-serif;color:${INK};max-width:520px;margin:0 auto;padding:24px">
  <div style="font-weight:800;letter-spacing:.03em;font-size:18px;margin-bottom:20px">${siteConfig.siteName.toUpperCase()}</div>
  <h1 style="font-size:20px;margin:0 0 12px">${title}</h1>
  ${body}
  <p style="color:#828aa6;font-size:12px;margin-top:28px">${siteConfig.siteName}, Aruba. We bring the car to you.</p>
</div>`;
}

const money = (cents: number, currency: string) => `${currency} ${(cents / 100).toFixed(2)}`;

export function loginCodeEmail(args: { code: string; link: string }): RenderedEmail {
  return {
    subject: `Your ${siteConfig.siteName} sign-in code`,
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
  amountPaidCents?: number; chargeType?: string;
}): RenderedEmail {
  const CHARGE_LABEL: Record<string, string> = {
    reservation_fee: "(reservation fee)",
    deposit: "(refundable deposit)",
    rental_deposit: "(deposit, balance due at pickup)",
    rental_full: "(paid in full)",
    extension: "(extension payment)",
  };
  const paidLine = args.amountPaidCents !== undefined
    ? `Paid now: <strong>${money(args.amountPaidCents, args.currency)}</strong> ${CHARGE_LABEL[args.chargeType ?? ""] ?? ""}<br>`
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

export function bookingCancelledEmail(args: {
  vehicleName: string; startAt: string; endAt: string;
  refund: { refunded: boolean; refundCents: number; refundError?: boolean; policySaysFree?: boolean };
  cancellationWindowHours: number; currency: string;
}): RenderedEmail {
  const { refund } = args;
  const refundLine = refund.refundError
    ? "Your refund is being processed and will land on your card soon."
    : refund.refunded
    ? `Your payment of ${money(refund.refundCents, args.currency)} has been refunded to your card.`
    // policySaysFree true here means the window would have allowed a refund,
    // but it was explicitly denied (an admin override), not a policy outcome.
    : refund.policySaysFree
    ? "Your payment was not refunded for this cancellation."
    : `Cancelled within ${args.cancellationWindowHours} hours of pickup: the deposit is not refunded, as per the cancellation policy.`;
  return {
    subject: `Your ${args.vehicleName} booking was cancelled`,
    html: shell("Booking cancelled", `
      <p>Your booking for the <strong>${args.vehicleName}</strong> (${formatDateTime(args.startAt)} to ${formatDateTime(args.endAt)}) has been cancelled.</p>
      <p>${refundLine}</p>`),
  };
}

export function bookingExtendedEmail(args: {
  vehicleName: string; newEndAt: string; deltaCents: number; currency: string; checkoutUrl: string | null;
}): RenderedEmail {
  // Three outcomes: pay-by-link (a Stripe link to settle the delta), paid at the
  // desk (nothing owed online), or a zero delta (the longer rental cost no more).
  const payLine = args.checkoutUrl
    ? `To lock in the extra time, pay securely here: <a href="${args.checkoutUrl}" style="color:${BRAND}">Pay ${money(args.deltaCents, args.currency)}</a>`
    : args.deltaCents > 0
    ? `The extra ${money(args.deltaCents, args.currency)} was paid at the desk. Nothing more to do.`
    : "There is nothing extra to pay for the added time. Enjoy the road.";
  return {
    subject: `Your ${args.vehicleName} rental is extended`,
    html: shell("Rental extended", `
      <p>Good news, we pushed your return out.</p>
      <p><strong>${args.vehicleName}</strong><br>Now yours until ${formatDateTime(args.newEndAt)}</p>
      <p>${payLine}</p>`),
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

export function adminDocumentExpiringEmail(args: {
  vehicleName: string; plate: string; kind: "insurance" | "inspection"; dueOn: string; daysLeft: number;
}): RenderedEmail {
  const doc = args.kind === "insurance" ? "Insurance" : "Inspection";
  const overdue = args.daysLeft < 0;
  const when = overdue
    ? `was due on ${args.dueOn} and is now overdue`
    : args.daysLeft === 0
      ? `is due today (${args.dueOn})`
      : `is due in ${args.daysLeft} ${args.daysLeft === 1 ? "day" : "days"} (${args.dueOn})`;
  return {
    subject: overdue
      ? `${doc} overdue: ${args.vehicleName} (${args.plate})`
      : `${doc} due soon: ${args.vehicleName} (${args.plate})`,
    html: shell(overdue ? `${doc} overdue` : `${doc} due soon`, `
      <p>The ${doc.toLowerCase()} for <strong>${args.vehicleName}</strong> (${args.plate}) ${when}.</p>
      <p>Once it is renewed, enter the new date in Fleet and the reminders reset for the next cycle.</p>`),
  };
}

export function bookingPickedUpEmail(args: {
  vehicleName: string; periodStart: string; periodEnd: string;
  balanceDueCents: number; borgReceivedCents: number | null; currency: string;
}): RenderedEmail {
  const balanceLine = args.balanceDueCents > 0
    ? `<br>Still open: <strong>${money(args.balanceDueCents, args.currency)}</strong>`
    : "";
  const borgLine = args.borgReceivedCents
    ? `<br>Security deposit received: ${money(args.borgReceivedCents, args.currency)} (refundable at return)`
    : "";
  return {
    subject: `You are on the road: ${args.vehicleName}`,
    html: shell("Enjoy the ride", `
      <p>Your ${args.vehicleName} is checked out and ready. Your signed rental contract is attached to this email.</p>
      <p><strong>${args.vehicleName}</strong><br>${args.periodStart} to ${args.periodEnd}${balanceLine}${borgLine}</p>
      <p>Questions during your rental? Just reply here or message us on WhatsApp.</p>`),
  };
}

export function bookingReturnSummaryEmail(args: {
  vehicleName: string; returnedAt: string; newDamage: boolean;
  borgReturnedCents: number | null; borgWithheldCents: number | null;
  borgWithheldReason: string | null; currency: string;
}): RenderedEmail {
  const damagePara = args.newDamage
    ? `<p>We noted new damage at return and documented it with photos. Our team will be in touch if anything more is needed.</p>`
    : `<p>The car came back in great shape. Thank you for taking care of it.</p>`;
  const borgPara = args.borgReturnedCents !== null || args.borgWithheldCents !== null
    ? `<p>Security deposit: <strong>${money(args.borgReturnedCents ?? 0, args.currency)}</strong> returned${
        args.borgWithheldCents
          ? `, ${money(args.borgWithheldCents, args.currency)} withheld (${args.borgWithheldReason ?? "see notes"})`
          : ""
      }.</p>`
    : "";
  return {
    subject: `Thanks for riding with us: ${args.vehicleName} returned`,
    html: shell("Rental completed", `
      <p>Your ${args.vehicleName} was returned on ${args.returnedAt}.</p>
      ${damagePara}
      ${borgPara}
      <p>We would love to see you again next trip.</p>`),
  };
}
