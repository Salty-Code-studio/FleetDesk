/**
 * Transactional email templates (spec §9). Brand-aligned, plain, warm, and
 * dash-free (house writing rule). Pure functions → unit-testable.
 *
 * Branded HTML shell (2026-08-29, back-ported from the Tex Cars redesign and
 * the Little John full-shell generalization): real HTML email discipline
 * throughout. Table layout, every style inline, 600px centered card, system
 * font stack, a text wordmark instead of a logo image, and no property Gmail
 * strips (no flexbox/grid/position anywhere). Explicit background-color is
 * paired with every explicit text color so dark-mode clients never invert one
 * half of a pair and leave pale text stranded on an assumed-white surface.
 * Content reads correctly top to bottom in raw DOM order, which stands in for
 * a plain-text fallback since the send path has no separate text/plain part
 * (src/lib/email/send.ts).
 *
 * White-label rule: no client literals in here. The wordmark, host, and every
 * contact affordance come from siteConfig (env-driven), so a client deploy
 * rebrands these emails without touching this file. Palette mirrors the
 * public app's own tokens (--sand, --ink-soft, --line).
 */
import { formatDateTime } from "@/lib/time/format";
import { siteConfig } from "@/lib/site-config";

export interface RenderedEmail {
  subject: string;
  html: string;
}

const BRAND = "#2348c7";  // the one accent: links and the primary button
const INK = "#15192f";
const SAND = "#f7f8fc";   // warm-white canvas + inset contact card
const MUTED = "#4a5170";  // secondary text
const LINE = "#e6e9f2";   // hairline rule between detail rows

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

/** Minimal guard for DB-sourced text dropped into the structured detail rows
 *  (vehicle names, customer emails, plates). Body sentences keep their
 *  original unescaped interpolation so approved copy stays byte-identical. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const money = (cents: number, currency: string) => `${currency} ${(cents / 100).toFixed(2)}`;

/** Table-based CTA button (bulletproof enough without VML: solid bgcolor td). */
function button(href: string, label: string, color: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table">
<tr>
<td style="border-radius:8px;background-color:${color}" bgcolor="${color}">
<a href="${href}" target="_blank" rel="noreferrer" style="display:block;padding:13px 26px;font-family:${FONT};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px">${label}</a>
</td>
</tr>
</table>`;
}

interface ShellOpts {
  title: string;
  /** Hidden inbox-preview line. Mind the desk-mode word bans (see
   *  bookingConfirmedEmail): a preheader is part of the html like anything else. */
  preheader: string;
  /** Paragraph html, rendered above the detail rows. */
  body: string;
  /** Label/value detail rows rendered as a hairline table. Values holding
   *  DB-sourced text must arrive pre-escaped via esc(). The optional third
   *  element renders the value in the mono stack (booking references). */
  rows?: Array<[label: string, value: string, mono?: boolean]>;
  /** Paragraph html rendered below the detail rows. */
  after?: string;
  /** Sand inset card with the WhatsApp button + reply line. Customer emails
   *  only; admin and auth emails stay compact. */
  contact?: boolean;
}

function shell(opts: ShellOpts): string {
  const siteHost = siteConfig.siteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");

  const rowsHtml = opts.rows?.length
    ? `<tr>
<td style="padding:20px 32px 4px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">${opts.rows.map(([label, value, mono], i) => {
        const border = i < opts.rows!.length - 1 ? `border-bottom:1px solid ${LINE};` : "";
        return `
<tr>
<td style="padding:11px 2px;${border}color:${MUTED};font-size:13px;font-family:${FONT}">${label}</td>
<td style="padding:11px 2px;${border}color:${INK};font-size:14px;font-weight:700;text-align:right;font-family:${mono ? MONO : FONT};${mono ? "letter-spacing:.04em;" : ""}">${value}</td>
</tr>`;
      }).join("")}
</table>
</td>
</tr>`
    : "";

  const afterHtml = opts.after
    ? `<tr>
<td style="padding:18px 32px 4px;font-family:${FONT};font-size:15px;line-height:1.6;color:${INK}">${opts.after}</td>
</tr>`
    : "";

  // Contact affordances are config-driven: siteConfig is the one module that
  // keeps the WhatsApp number in sync across surfaces, so no wa.me or phone
  // literal may live here. No configured number means no button and no phone
  // line, while the reply-to sentence always renders so the block never goes
  // contactless. telHref strips the display's formatting back to dialable.
  const telHref = siteConfig.whatsappDisplay
    ? `tel:${siteConfig.whatsappDisplay.replace(/[^+\d]/g, "")}`
    : null;
  const reachLine = siteConfig.whatsappDisplay && telHref
    ? `${siteConfig.whatsappHref ? "Or reach us at" : "Reach us at"} <a href="${telHref}" style="color:${BRAND};text-decoration:underline">${siteConfig.whatsappDisplay}</a>, or simply reply to this email.`
    : siteConfig.whatsappHref
    ? "Or simply reply to this email."
    : "";
  const contactHtml = opts.contact
    ? `<tr>
<td style="padding:24px 32px 8px;font-family:${FONT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${SAND};border-radius:10px" bgcolor="${SAND}">
<tr>
<td style="padding:22px 24px">
<p style="margin:0 0 8px;font-size:15px;font-weight:700;color:${INK}">Questions or special requests</p>
<p style="margin:0 0 ${siteConfig.whatsappHref ? "16px" : "0"};font-size:14px;line-height:1.6;color:${MUTED}">${siteConfig.whatsappHref ? "Message us on WhatsApp any time and we will get right back to you." : "Just reply to this email and we will get right back to you."}</p>
${siteConfig.whatsappHref ? button(siteConfig.whatsappHref, "Message us on WhatsApp", BRAND) : ""}${reachLine ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:${MUTED}">${reachLine}</p>` : ""}
</td>
</tr>
</table>
</td>
</tr>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="x-apple-disable-message-reformatting">
<title>${opts.title}</title>
</head>
<body style="margin:0;padding:0;background-color:${SAND}" bgcolor="${SAND}">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;color:${SAND}">${opts.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${SAND}" bgcolor="${SAND}">
<tr>
<td align="center" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;background-color:#ffffff;border-radius:14px;box-shadow:0 1px 2px rgba(21,25,47,0.06)" bgcolor="#ffffff">
<tr>
<td style="background-color:${INK};padding:28px 32px;text-align:center;border-radius:14px 14px 0 0" bgcolor="${INK}">
<span style="font-family:${FONT};font-size:20px;font-weight:800;letter-spacing:.04em;color:#ffffff">${siteConfig.siteName.toUpperCase()}</span>
</td>
</tr>
<tr>
<td style="padding:32px 32px 4px;font-family:${FONT}">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:${INK};font-weight:700">${opts.title}</h1>
<div style="font-size:15px;line-height:1.6;color:${INK}">${opts.body}</div>
</td>
</tr>
${rowsHtml}
${afterHtml}
${contactHtml}
<tr>
<td style="padding:20px 32px 32px;border-top:1px solid ${LINE};font-family:${FONT}">
<p style="margin:0;font-size:12px;line-height:1.7;color:${MUTED}">${siteConfig.siteName}, Aruba<br><a href="${siteConfig.siteUrl}" target="_blank" rel="noreferrer" style="color:${MUTED};text-decoration:underline">${siteHost}</a><br>We bring the car to you.</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}

export function loginCodeEmail(args: { code: string; link: string }): RenderedEmail {
  return {
    subject: `Your ${siteConfig.siteName} sign-in code`,
    html: shell({
      title: "Sign in to your bookings",
      preheader: `Your sign-in code is ${args.code}. It is good for 15 minutes.`,
      body: `
      <p style="margin:0 0 12px">Use this code to sign in. It is good for 15 minutes.</p>
      <p style="font-size:32px;font-weight:800;letter-spacing:6px;color:${BRAND};margin:16px 0;font-family:${FONT}">${args.code}</p>
      <p style="margin:0 0 12px">Or just tap this link: <a href="${args.link}" style="color:${BRAND}">Sign in</a></p>
      <p style="color:${MUTED};font-size:13px;margin:0 0 8px">If you did not request this, you can ignore this email.</p>`,
    }),
  };
}

/**
 * The customer-facing "booking confirmed" email (spec §9, Tex Cars redesign
 * back-port). Serves BOTH the online (`paid: true`, Stripe webhook) and desk
 * (`paid: false`, Telegram/email/admin confirm) origins through
 * notifyBookingConfirmed's one shared funnel, so this one template covers
 * both, and the online branch keeps its pinned opening sentence byte-for-byte
 * (src/test/desk-confirm-copy.test.ts) so a refactor here can never quietly
 * start claiming a payment that did not happen, or vice versa. The word
 * "payment" must not appear ANYWHERE in the desk variant's html, preheader
 * included.
 */
export function bookingConfirmedEmail(args: {
  /** Full booking id; the email derives its own short reference from it, the
   *  same slice(0,8).toUpperCase() the confirmation page and the rental
   *  contract PDF already use, so the number here, on screen, and on paper
   *  all match. */
  bookingId: string;
  vehicleClass: string; vehicleName: string; startAt: string; endAt: string;
  /** Renter's full name (customers.name); only the first name is greeted. */
  customerName: string;
  rentalTotalCents: number; currency: string;
  /** Refundable security hold from the quote snapshot (QuoteBreakdown's
   *  depositCents). Undefined/null until the owner sets a per-class deposit,
   *  in which case the row is simply omitted, same as the confirmation page. */
  depositCents?: number | null;
  amountPaidCents?: number; chargeType?: string;
  /** Whether a real online payment succeeded for this booking. Keyed on DATA
   *  (the caller already looked up the payment row), never on deployment
   *  mode: a desk-mode confirmation has no payment to claim, so the copy
   *  must say so instead of thanking the customer for a charge that never
   *  happened. */
  paid: boolean;
}): RenderedEmail {
  const CHARGE_LABEL: Record<string, string> = {
    reservation_fee: "(reservation fee)",
    deposit: "(refundable deposit)",
    rental_deposit: "(deposit, balance due at pickup)",
    rental_full: "(paid in full)",
    extension: "(extension payment)",
  };

  const first = esc(args.customerName.trim().split(/\s+/)[0] || "there");
  const ref = args.bookingId.slice(0, 8).toUpperCase();

  const greetingLine = args.paid
    ? `Hi ${first}. Thanks, your payment came through and your car is reserved.`
    : `Hi ${first}, thanks for booking with ${siteConfig.siteName}.`;
  const payNoteLine = args.paid
    ? "Any remaining balance is settled with you at pickup."
    : "You pay at pickup, by cash or card at the desk. Nothing is charged online.";
  const preheader = args.paid
    ? "Your booking is confirmed. Payment received, see you at pickup."
    : "Your booking is confirmed. Pay at pickup, cash or card.";

  const rows: Array<[label: string, value: string, mono?: boolean]> = [
    ["Class", esc(args.vehicleClass)],
    ["Car", esc(args.vehicleName)],
    ["Pickup", formatDateTime(args.startAt)],
    ["Return", formatDateTime(args.endAt)],
  ];
  if (args.amountPaidCents !== undefined) {
    const label = CHARGE_LABEL[args.chargeType ?? ""] ?? "";
    rows.push(["Paid now", `${money(args.amountPaidCents, args.currency)}${label ? ` ${label}` : ""}`]);
  }
  rows.push(["Rental total", money(args.rentalTotalCents, args.currency)]);
  if (typeof args.depositCents === "number") {
    rows.push(["Refundable deposit", money(args.depositCents, args.currency)]);
  }
  rows.push(["Reservation reference", ref, true]);

  return {
    subject: `Your ${args.vehicleName} booking is confirmed`,
    html: shell({
      title: "Your booking is confirmed",
      preheader,
      body: `
      <p style="margin:0">${greetingLine}</p>`,
      rows,
      after: `
      <p style="margin:0 0 12px;font-size:14px;color:${MUTED}">${payNoteLine}</p>
      <p style="margin:0 0 12px">We will reach out on WhatsApp to arrange delivery. See you soon.</p>
      <p style="margin:0;font-size:13px;color:${MUTED}">Bring your driver's licence. We check it when you pick up the car.</p>`,
      contact: true,
    }),
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
    html: shell({
      title: "Booking cancelled",
      preheader: "Your booking has been cancelled.",
      body: `
      <p style="margin:0 0 12px">Your booking for the <strong>${args.vehicleName}</strong> (${formatDateTime(args.startAt)} to ${formatDateTime(args.endAt)}) has been cancelled.</p>
      <p style="margin:0">${refundLine}</p>`,
      contact: true,
    }),
  };
}

export function bookingExtendedEmail(args: {
  vehicleName: string; newEndAt: string; deltaCents: number; currency: string; checkoutUrl: string | null;
}): RenderedEmail {
  // Three outcomes: pay-by-link (a Stripe link to settle the delta), paid at the
  // desk (nothing owed online), or a zero delta (the longer rental cost no more).
  const payBlock = args.checkoutUrl
    ? `<p style="margin:0 0 14px">To lock in the extra time, pay securely here:</p>
      ${button(args.checkoutUrl, `Pay ${money(args.deltaCents, args.currency)}`, BRAND)}`
    : args.deltaCents > 0
    ? `<p style="margin:0">The extra ${money(args.deltaCents, args.currency)} was paid at the desk. Nothing more to do.</p>`
    : `<p style="margin:0">There is nothing extra to pay for the added time. Enjoy the road.</p>`;
  return {
    subject: `Your ${args.vehicleName} rental is extended`,
    html: shell({
      title: "Rental extended",
      preheader: `Your ${args.vehicleName} is now yours for longer.`,
      body: `
      <p style="margin:0">Good news, we pushed your return out.</p>`,
      rows: [
        ["Car", esc(args.vehicleName)],
        ["Now yours until", formatDateTime(args.newEndAt)],
      ],
      after: payBlock,
      contact: true,
    }),
  };
}

export function adminNewBookingEmail(args: { vehicleName: string; startAt: string; endAt: string; customerEmail: string; paymentOption: string }): RenderedEmail {
  return {
    subject: `New booking: ${args.vehicleName} (${formatDateTime(args.startAt)})`,
    html: shell({
      title: "New booking",
      preheader: `${args.vehicleName}, ${formatDateTime(args.startAt)}.`,
      body: `
      <p style="margin:0">A new booking just came in.</p>`,
      rows: [
        ["Car", esc(args.vehicleName)],
        ["Rental period", `${formatDateTime(args.startAt)} to ${formatDateTime(args.endAt)}`],
        ["Customer", esc(args.customerEmail)],
        ["Payment", esc(args.paymentOption.replace(/_/g, " "))],
      ],
    }),
  };
}

export function adminPaymentEmail(args: { vehicleName: string; startAt: string; endAt: string; amountCents: number; currency: string; customerEmail: string }): RenderedEmail {
  return {
    subject: `Payment received: ${money(args.amountCents, args.currency)}`,
    html: shell({
      title: "Payment received",
      preheader: `${money(args.amountCents, args.currency)} from ${args.customerEmail}.`,
      body: `
      <p style="margin:0">Payment confirmed and the booking is now confirmed.</p>`,
      rows: [
        ["Car", esc(args.vehicleName)],
        ["Rental period", `${formatDateTime(args.startAt)} to ${formatDateTime(args.endAt)}`],
        ["Received", `${money(args.amountCents, args.currency)} from ${esc(args.customerEmail)}`],
      ],
    }),
  };
}

/** Owner copy on a desk-mode confirm (Telegram tap, email link, or admin
 *  button): no payment row exists to report, so the owner gets a
 *  reservation-confirmed summary instead of a payment alert. */
export function adminReservationConfirmedEmail(args: {
  vehicleName: string; startAt: string; endAt: string; rentalTotalCents: number; currency: string; customerEmail: string;
}): RenderedEmail {
  return {
    subject: `Reservation confirmed: ${args.vehicleName}`,
    html: shell({
      title: "Reservation confirmed",
      preheader: `${args.vehicleName}, pays at pickup.`,
      body: `
      <p style="margin:0">A desk reservation is now confirmed. No online payment was taken. The customer pays at pickup.</p>`,
      rows: [
        ["Car", esc(args.vehicleName)],
        ["Rental period", `${formatDateTime(args.startAt)} to ${formatDateTime(args.endAt)}`],
        ["Rental total", `${money(args.rentalTotalCents, args.currency)} from ${esc(args.customerEmail)}`],
      ],
    }),
  };
}

export function approvalDecisionEmail(args: {
  siteName: string; messageText: string; approveUrl: string; declineUrl: string;
}): RenderedEmail {
  const lines = args.messageText.split("\n").map((l) => `${l}<br>`).join("");
  return {
    subject: `Booking to confirm at ${args.siteName}`,
    html: shell({
      title: "Booking to confirm",
      preheader: "A new booking is waiting for a quick yes or no.",
      body: `
      <p style="margin:0 0 12px">A new booking came in and is waiting for a quick yes or no.</p>
      <p style="margin:0">${lines}</p>`,
      after: `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr>
      <td style="padding:0 8px 0 0">${button(args.approveUrl, "Review and confirm", "#16a34a")}</td>
      <td>${button(args.declineUrl, "Review and decline", "#dc2626")}</td>
      </tr>
      </table>
      <p style="margin:16px 0 0;font-size:14px;line-height:1.6;color:${MUTED}">The buttons open a small review page first, so nothing happens by accident. If the booking was already handled you will see who did it.</p>`,
    }),
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
    html: shell({
      title: overdue ? `${doc} overdue` : `${doc} due soon`,
      preheader: `${args.vehicleName} (${args.plate}).`,
      body: `
      <p style="margin:0 0 12px">The ${doc.toLowerCase()} for <strong>${args.vehicleName}</strong> (${args.plate}) ${when}.</p>
      <p style="margin:0">Once it is renewed, enter the new date in Fleet and the reminders reset for the next cycle.</p>`,
    }),
  };
}

export function bookingPickedUpEmail(args: {
  vehicleName: string; periodStart: string; periodEnd: string;
  balanceDueCents: number; borgReceivedCents: number | null; currency: string;
}): RenderedEmail {
  const rows: Array<[string, string]> = [
    ["Car", esc(args.vehicleName)],
    ["Rental period", `${esc(args.periodStart)} to ${esc(args.periodEnd)}`],
  ];
  if (args.balanceDueCents > 0) {
    rows.push(["Still open", money(args.balanceDueCents, args.currency)]);
  }
  if (args.borgReceivedCents) {
    rows.push(["Security deposit received", `${money(args.borgReceivedCents, args.currency)} (refundable at return)`]);
  }
  return {
    subject: `You are on the road: ${args.vehicleName}`,
    html: shell({
      title: "Enjoy the ride",
      preheader: `Your ${args.vehicleName} is checked out and ready.`,
      body: `
      <p style="margin:0">Your ${args.vehicleName} is checked out and ready. Your signed rental contract is attached to this email.</p>`,
      rows,
      after: `
      <p style="margin:0">Questions during your rental? Just reply here or message us on WhatsApp.</p>`,
      contact: true,
    }),
  };
}

export function bookingReturnSummaryEmail(args: {
  vehicleName: string; returnedAt: string; newDamage: boolean;
  borgReturnedCents: number | null; borgWithheldCents: number | null;
  borgWithheldReason: string | null; currency: string;
}): RenderedEmail {
  const damagePara = args.newDamage
    ? `<p style="margin:0 0 12px">We noted new damage at return and documented it with photos. Our team will be in touch if anything more is needed.</p>`
    : `<p style="margin:0 0 12px">The car came back in great shape. Thank you for taking care of it.</p>`;
  const borgPara = args.borgReturnedCents !== null || args.borgWithheldCents !== null
    ? `<p style="margin:0 0 12px">Security deposit: <strong>${money(args.borgReturnedCents ?? 0, args.currency)}</strong> returned${
        args.borgWithheldCents
          ? `, ${money(args.borgWithheldCents, args.currency)} withheld (${args.borgWithheldReason ?? "see notes"})`
          : ""
      }.</p>`
    : "";
  return {
    subject: `Thanks for riding with us: ${args.vehicleName} returned`,
    html: shell({
      title: "Rental completed",
      preheader: `Your ${args.vehicleName} was returned. Thanks for riding with us.`,
      body: `
      <p style="margin:0 0 12px">Your ${args.vehicleName} was returned on ${args.returnedAt}.</p>
      ${damagePara}
      ${borgPara}
      <p style="margin:0">We would love to see you again next trip.</p>`,
      contact: true,
    }),
  };
}
