# Desk Mode + Internal Chat Approval

Date: 2026-08-17
Status: Approved by Mo (brainstorm 2026-08-17), pending spec review
Scope: FleetDesk main repo. Rolls out to Little John by pulling main, to Tex Cars via a FleetDesk deployment, and to every future client as configuration only.

## 1. Context and problem

Several current and future FleetDesk clients cannot take online payments. Stripe does not support their country or bank, and sentoo.io does not cover them either. Today the FleetDesk booking flow requires Stripe: checkout creates a `pending` booking and the Stripe webhook flips it to `confirmed`. Without a payment provider the website cannot feed the back office, so staff re-enter bookings by hand. Little John's deployment already works around this with a hand-patched pay-at-desk fork, which proves the demand but does not scale.

Goal: the site must feed bookings straight into the back office with no payment hook at all, and managers get an internal chat message that lets them confirm the booking with one tap instead of opening the admin.

## 2. Goals

- A first-class per-deployment payment mode with no payment provider required.
- On each new booking in that mode, an internal WhatsApp message to registered managers with booking details, live availability from the back office, and Confirm / Decline buttons.
- A tap applies the decision in the back office automatically through the existing status machine.
- Email fallback with the same one-tap decision, working from day one and remaining as backup forever.
- Zero per-client Meta setup. Onboarding a new client is "enter manager phone numbers in settings".

## 3. Non-goals

- No customer-facing approval process. The chat loop is internal only, a convenience, never a gate.
- No auto-cancel of unanswered bookings. They stay pending like a manually entered booking.
- No Telegram adapter now. The core is channel-agnostic so one can be added later if a client wants it.
- No per-client WhatsApp numbers. One central FleetDesk number serves all deployments.
- No changes to the online (Stripe) mode.

## 4. Desk mode

A deployment-level payment mode: `online` (today's Stripe flow, unchanged) or `desk`.

In desk mode:

- Stripe environment variables are no longer required. `src/env.ts` validation for `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and related keys becomes conditional on the mode.
- The checkout step creates the booking directly via the existing `src/lib/booking/create.ts` path. No payment session, no redirect. The UI shows the price with "pay at pickup" where the payment step used to be. Button copy stays a normal booking action, not a request flow.
- The booking lands as `pending` and holds the car dates, which is existing behavior (`pending` already blocks availability in the conflict check).
- Stripe-only surfaces (payment links, refund actions on online payments) are hidden in the admin for desk-mode deployments. The existing desk-payment recording route stays, since desk mode is exactly where it is used.
- `pending -> confirmed` no longer has any payment trigger in this mode. The triggers are: the chat approval loop below, or a normal click in the admin.

Customer-side email flow is untouched: the existing received email at booking creation, the existing confirmation email when the booking becomes confirmed, the existing cancellation email if it is cancelled. No new customer-facing states or copy beyond the pay-at-pickup label at checkout.

## 5. Approval core (channel-agnostic)

New module `src/lib/approval/` plus one table.

Data model, table `approval_requests`:

- `id`, `bookingId` (FK, one open request per booking)
- `status`: `open` | `confirmed` | `declined` | `closed` (closed = booking got decided in the admin instead, or cancelled elsewhere)
- `tokenHash`: hash of the signed single-use token for this request
- `expiresAt`: token validity, 7 days
- `sentTo`: JSON list of channel deliveries (channel, recipient, message id, sentAt)
- `remindedAt`, `reminderCount`
- `decidedBy` (manager label + phone/email), `decidedChannel`, `decidedAt`
- timestamps

Behavior:

- `createApprovalRequest(bookingId)` runs after desk-mode booking creation. Best-effort like all notifications: any failure here never breaks the booking.
- Message content is built from live back-office data: client/site name, booking ref, vehicle class and name, dates, price, customer name and phone, and a fleet line computed with the existing `checkAvailability` logic, for example "4 of 6 Economy free on those dates, no conflicts".
- `applyDecision(token, action, actor)`:
  - Verifies token, expiry, and that the request is still `open`.
  - Confirm: `pending -> confirmed` guarded by `assertBookingTransition`, wired to the same side effects the online flow runs after payment: the customer confirmation email, the admin bell entry, and the audit log.
  - Decline: `pending -> cancelled` via the existing cancel path, freeing the car.
  - First tap wins. The decision write is guarded so concurrent taps resolve to exactly one winner; later taps get an "already handled by {name}" outcome instead of an error.
  - Every decision writes an audit log entry with actor and channel.
- Admin race: if staff decide the booking in the admin UI while a request is open, the request moves to `closed` and any later tap gets the "already handled" outcome.
- Reminders: the existing cron infrastructure re-sends the ping for `open` requests after a configurable delay (default 4 hours), up to a configurable max (default 1 reminder). After that the booking simply stays pending and visible in the admin bell. Nothing customer-facing ever fires from this module.

Settings (admin UI, per deployment):

- Payment mode: `online` | `desk`.
- Managers: list of `{ name, whatsappNumber?, email? }` used as the ping recipients and the inbound allowlist.
- Reminder delay and max reminder count.

## 6. WhatsApp adapter (central number + router)

One central FleetDesk WhatsApp Business number on the official Meta Cloud API serves every deployment. Managers see pings from "FleetDesk".

Outbound:

- Business-initiated pings require a pre-approved template. One utility template with the booking summary body and two quick-reply buttons, Confirm and Decline. Reminder sends reuse the same template.
- Sending goes through the existing Meta client in `src/lib/notify.ts`, extended from the single-owner env pair to the managers list from settings.
- Each button carries an opaque payload set at send time: `{ deploymentId, callbackBaseUrl, bookingRef, action, token }`, signed so the router can trust it.

Inbound (the router):

- Meta delivers replies to one webhook per app. A small router endpoint lives once at fleetdesk.app, roughly a hundred lines, deliberately dumb:
  1. Verify Meta's `X-Hub-Signature-256`.
  2. Read the button payload, verify its signature.
  3. Forward `{ payload, senderPhone }` to `{callbackBaseUrl}/api/webhooks/chat-approval` with a shared secret header.
  4. Return 200 to Meta fast. Meta retries undelivered webhooks, and the reminder cron is the safety net behind that.
- The deployment endpoint `/api/webhooks/chat-approval`:
  1. Verify the shared secret.
  2. Check `senderPhone` against the managers allowlist. Unknown senders are ignored and logged.
  3. Call `applyDecision`.
  4. Reply into the chat via the send API: "Confirmed by Naomi" or "Declined by Naomi", also sent to the other managers so nobody double-acts. "Already handled" goes only to the late tapper.

Meta account notes (manual, one-time, owner gate for Mo):

- Create the WABA, register one number, submit the template. The unverified tier allows a limited number of business-initiated conversations per day, enough to start the same week; business verification lifts limits and adds the display name. Costs are a few cents per template message. Exact current limits and prices must be checked against Meta docs at implementation time.

## 7. Email adapter (always on)

- The existing owner alert email (Resend) grows Approve and Decline buttons carrying the same single-use token, sent to every manager with an email in settings.
- Links do not mutate on GET. They land on a minimal page showing the booking summary and one real button that POSTs the decision. This is deliberate: corporate mail scanners follow links and must never confirm a booking by accident.
- The page result mirrors the chat replies: confirmed, declined, or already handled by X.
- This adapter works before any Meta setup exists and stays as permanent backup. If WhatsApp send fails, email and the admin bell still fire.

## 8. Security

- Tokens: single-use, signed (HMAC with a server secret), scoped to one approval request, hashed at rest, 7-day expiry.
- Meta webhook signature verification at the router; signed button payloads; shared-secret authentication from router to deployment; the deployment endpoint accepts nothing without it.
- Manager phone allowlist per deployment; unknown senders logged, never acted on.
- Idempotent decision application, safe under Meta redeliveries, double-taps, and email retries.
- Audit log entries for every decision with actor identity and channel.
- Existing rate limiting applies to the new public endpoints (router, chat-approval webhook, email decision page).

## 9. Error handling

- Approval creation and message sending are best-effort and never break booking creation, matching the existing `notify.ts` contract.
- WhatsApp down or unconfigured: email buttons and admin bell still work, reminder cron keeps nudging.
- Router cannot reach a deployment: Meta redelivery retries first, reminder cron is the backstop, and the booking is safely sitting in the admin regardless.
- Token expired or request closed: the tapper gets a clear "this one was already handled or expired, open the admin" reply, never a silent failure.

## 10. Rollout

1. Build and test in FleetDesk main behind the mode setting. DEMO_MODE keeps working; the demo can show the desk-mode checkout and a simulated approval.
2. Little John: pull main, switch the deployment to desk mode, enter manager numbers, retire the hand-patched fork behavior.
3. Tex Cars: goes live on a FleetDesk deployment like Little John, rather than porting this into the older Tex Phase 2 codebase twice.
4. Future clients: deploy FleetDesk, set mode to desk, add manager numbers. No Meta work per client.
5. Owner gate for Mo, one time: Meta business account, WABA number, template approval, router secrets. A runbook section in LAUNCH.md will list the exact steps.

## 11. Testing

- Unit: token issue/verify/expiry, first-tap-wins decision guard, allowlist checks, message content builder including the fleet line.
- Integration (Vitest, existing harness): desk-mode booking creation without Stripe env; `/api/webhooks/chat-approval` with fake router payloads covering confirm, decline, double-tap, unknown sender, expired token, admin-race `closed`; email decision page POST flow.
- Router: signature verification and forwarding tested with fake Meta webhook payloads.
- Manual E2E before client rollout: real template send to a test number, tap both buttons, verify back office state, audit entries, and the "handled by" fan-out.

## 12. Open items

- Template wording must pass Meta review; final copy written at implementation time.
- Router hosting: default is a route on the fleetdesk.app deployment; a Cloudflare Worker is the fallback if we want it fully isolated.
- Exact Meta unverified-tier limits and per-message prices to confirm against current docs when the WABA is created.
