# Desk Mode + Internal Chat Approval (Telegram)

Date: 2026-08-17
Status: Approved by Mo (brainstorm 2026-08-17; channel switched from WhatsApp to Telegram same day, Mo's call)
Scope: FleetDesk main repo. Rolls out to Little John by pulling main, to Tex Cars via a FleetDesk deployment, and to every future client as configuration only.

## 1. Context and problem

Several current and future FleetDesk clients cannot take online payments. Stripe does not support their country or bank, and sentoo.io does not cover them either. Today the FleetDesk booking flow requires Stripe: checkout creates a `pending` booking and the Stripe webhook flips it to `confirmed`. Without a payment provider the website cannot feed the back office, so staff re-enter bookings by hand. Little John's deployment already works around this with a hand-patched pay-at-desk fork, which proves the demand but does not scale.

Goal: the site must feed bookings straight into the back office with no payment hook at all, and managers get an internal chat message that lets them confirm the booking with one tap instead of opening the admin.

## 2. Goals

- A first-class per-deployment payment mode with no payment provider required.
- On each new booking in that mode, an internal Telegram message to linked managers with booking details, live availability from the back office, and Confirm / Decline buttons.
- A tap applies the decision in the back office automatically through the existing status machine, and the chat message itself updates to show who handled it.
- Email fallback with the same one-tap decision, working from day one and remaining as backup forever.
- Near-zero per-client setup: create a bot with BotFather (minutes, free), set two env vars, run one setup script, send managers their invite links.

## 3. Non-goals

- No customer-facing approval process. The chat loop is internal only, a convenience, never a gate.
- No auto-cancel of unanswered bookings. They stay pending like a manually entered booking.
- No WhatsApp adapter now. The core is channel-agnostic; WhatsApp (Meta Cloud API, central number plus router) was the original design and can be added later if a client demands it. The dormant owner-alert WhatsApp path in `notify.ts` stays as-is and is unrelated.
- No changes to the online (Stripe) mode.

## 4. Desk mode

A deployment-level payment mode: `online` (today's Stripe flow, unchanged) or `desk`, set by the `PAYMENT_MODE` env var (default `online`).

In desk mode:

- Stripe environment variables are no longer required. `src/env.ts` validation for `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` becomes conditional on the mode.
- The checkout step creates the booking directly via the existing `src/lib/booking/create.ts` path. No payment session, no redirect. The UI shows the price with "pay at pickup" where the payment step used to be. Button copy stays a normal booking action, not a request flow.
- The booking lands as `pending` and holds the car dates, which is existing behavior (`pending` already blocks availability in the conflict check).
- The `payNowCents <= 0` guard in `createBooking` is skipped in desk mode (nothing is charged online, so an uncharged booking is not an error).
- The unpaid-hold expiry cron (`expireStaleHolds`) is skipped in desk mode. Its whole reason to exist is abandoning unpaid online checkouts; in desk mode it would cancel every booking after 30 minutes.
- The Stripe checkout route and Stripe webhook route respond 409/404 in desk mode.
- `pending -> confirmed` triggers in this mode: the chat approval loop below, or the admin. The admin gains a proper Confirm action (`POST /api/admin/bookings/[id]/confirm`), which did not exist before because only the Stripe webhook confirmed bookings.

Customer-side email flow is untouched: the existing received email at booking creation, the existing confirmation email when the booking becomes confirmed, the existing cancellation email if it is cancelled. No new customer-facing states or copy beyond the pay-at-pickup label at checkout and a desk-mode variant of the confirmation page copy.

## 5. Approval core (channel-agnostic)

New module `src/lib/approval/` plus one table.

Data model, table `approval_requests`:

- `id`, `bookingId` (FK, at most one `open` request per booking, enforced by a partial unique index)
- `status`: `open` | `confirmed` | `declined` | `closed` (closed = booking got decided elsewhere, e.g. in the admin, or the request went stale)
- `tokenHash`: sha256 of the signed single-use token used by the email links
- `expiresAt`: token validity, 7 days
- `sentTo`: JSON list of deliveries `{ channel, to, messageId?, sentAt }` (for Telegram, `to` is the chat id and `messageId` lets us edit the message after the decision)
- `remindedAt`, `reminderCount`
- `decidedBy` (manager name), `decidedChannel` (`telegram` | `email` | `admin`), `decidedAt`
- timestamps

Behavior:

- `createApprovalRequest(bookingId)` runs after desk-mode booking creation. Best-effort like all notifications: any failure here never breaks the booking.
- Message content is built from live back-office data: site name, vehicle name, dates, price, customer name and phone, and a fleet line computed with the same overlap rules the site uses, for example "Fleet check: 4 of 6 Economy free on those dates" (count of active vehicles of the booked vehicle's class with no overlapping pending/confirmed/picked-up booking).
- `applyDecision(requestId, action, actor)`:
  - Runs in a transaction with the request row locked.
  - Rejects if the request is not `open` (returns an `already_handled` outcome with who decided) or the token/request expired.
  - Confirm: guarded flip `pending -> confirmed` (conditional update on current status), then the same side effects the online flow runs after payment: the customer confirmation email, the admin bell entry, and the audit log.
  - Decline: guarded flip `pending -> cancelled`, freeing the car, with the existing cancellation notification (no refund maths, desk mode has no payments).
  - If the booking is no longer `pending` (admin got there first), the request is marked `closed` and the tapper gets the `already_handled` outcome.
  - First tap wins. The row lock plus guarded update make concurrent taps resolve to exactly one winner.
  - Every decision writes an audit log entry with actor and channel.
- Reminders: the existing cron infrastructure re-sends the ping for `open` requests whose booking is still `pending`, after a configurable delay (default 4 hours), up to a configurable max (default 1 reminder). A janitor pass in the same cron closes `open` requests whose booking already left `pending`. After that the booking simply stays pending and visible in the admin bell. Nothing customer-facing ever fires from this module.

Settings (admin UI, per deployment):

- Managers: list of `{ name, email?, inviteCode, chatId? }`. The invite code links a Telegram account (below); the optional email receives the fallback decision email. Managers double as the inbound allowlist.
- Reminder delay hours and max reminder count.
- (Payment mode itself is an env var, not a DB setting: it changes which env is required, so it must be known at boot.)

## 6. Telegram adapter (one bot per deployment, no router)

Each client deployment gets its own free Telegram bot, created with BotFather in minutes. The bot's webhook points directly at that client's deployment, so no central routing exists at all.

Env per deployment: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` (a random secret we generate; Telegram echoes it back on every webhook call in the `X-Telegram-Bot-Api-Secret-Token` header). All optional: without them the Telegram channel is dormant and email still works.

Manager linking (bots cannot message a user first):

- Adding a manager in settings generates an `inviteCode`. The settings UI shows an invite link `https://t.me/<botUsername>?start=<inviteCode>`.
- The manager taps it, Telegram opens the bot chat, tapping Start sends `/start <inviteCode>`. The webhook matches the code, stores the manager's `chatId`, and replies "You're linked, {name}. Booking approvals for {site} will arrive here."
- A `/start` without a valid code gets "This bot only serves {site} staff. Ask your admin for an invite link." and is otherwise ignored.

Outbound ping: `sendMessage` to every linked manager with the booking summary text and an inline keyboard, two buttons whose `callback_data` is `apv:<requestId>:confirm` / `apv:<requestId>:decline` (fits Telegram's 64-byte callback limit; authorization comes from the webhook secret plus the tapper's chat id, not from a token in the button).

Inbound webhook `POST /api/webhooks/telegram`:

1. Verify the `X-Telegram-Bot-Api-Secret-Token` header.
2. `callback_query` updates: the tapper's chat id must belong to a linked manager (allowlist); unknown tappers get a polite callback answer and are logged, nothing else. Known tappers: `applyDecision(requestId, action, { name, channel: "telegram" })`.
3. After a decision: `answerCallbackQuery` (closes the button spinner), and every delivered message from `sentTo` is edited via `editMessageText` to the summary plus "Confirmed by Naomi" (or Declined), keyboard removed. So all managers' copies update in place and late taps have no buttons left to press. An `already_handled` outcome answers the callback with "Already handled by {name}".
4. `message` updates handle only the `/start <code>` linking flow above.
5. Always respond 200 fast so Telegram does not retry into a loop.

One small setup script `scripts/telegram-setup.ts` calls `setWebhook` with the deployment URL, the secret token, and `allowed_updates: ["message", "callback_query"]`, and prints `getMe` so the operator can verify the bot.

## 7. Email adapter (always on)

- Managers with an email in settings get a decision email (Resend, existing send infra) with Approve and Decline buttons carrying the request's single-use signed token.
- Links do not mutate on GET. They land on a minimal page (`/approve/[token]`) showing the booking summary and one real button that POSTs the decision. This is deliberate: corporate mail scanners follow links and must never confirm a booking by accident.
- Email decisions cannot identify which manager clicked (one shared token per request), so they are attributed as "Email approver" in `decidedBy`. Accepted limitation; Telegram taps are fully attributed.
- The page result mirrors the chat outcome: confirmed, declined, already handled by X, or expired.
- This adapter works with zero Telegram setup and stays as permanent backup. If Telegram send fails, email and the admin bell still fire.

## 8. Security

- Telegram inbound: webhook secret token header verified on every call; the tapper's chat id must match a linked manager; callback data carries only the request id and action, never authority.
- Email tokens: single-use, signed (HMAC-SHA256 keyed off a key derived from `SESSION_SECRET`), scoped to one approval request, stored hashed (sha256), 7-day expiry, constant-time comparison.
- Idempotent decision application, safe under Telegram retries, double-taps, and email retries (row lock plus guarded status update).
- Audit log entries for every decision with actor identity and channel.
- Existing rate limiting applies to the new public endpoints (Telegram webhook, approval summary/decide, decision page).
- Best-effort boundaries: approval creation and message sending never break booking creation, matching the existing `notify.ts` contract.

## 9. Error handling

- Telegram down or unconfigured: email buttons and the admin bell still work, the reminder cron keeps nudging.
- Telegram edit/answer failures after a decision are logged and swallowed; the back office state is already correct.
- Token expired or request closed: the actor gets a clear "already handled or expired, open the admin" outcome, never a silent failure.
- Unanswered forever: booking stays `pending`, visible in the admin, exactly like a manually entered one.

## 10. Rollout

1. Build and test in FleetDesk main behind `PAYMENT_MODE`. Existing online-mode deployments are untouched (default `online`).
2. Little John: pull main, set `PAYMENT_MODE=desk`, create their bot, run the setup script, add managers and send invite links, retire the fork patch.
3. Tex Cars: goes live on a FleetDesk deployment like Little John, rather than porting this into the older Tex Phase 2 codebase twice.
4. Future clients: deploy FleetDesk, set mode, create bot, invite managers. Minutes of setup, all free.
5. LAUNCH.md gains a "Desk mode + Telegram approvals" runbook covering BotFather, env vars, the setup script, invite links, and a manual E2E checklist.

## 11. Testing

- Unit: token issue/verify/expiry, first-tap-wins decision guard, allowlist checks, message content builder including the fleet line, Telegram update parsing.
- Integration (Vitest + PGlite, existing harness): desk-mode booking creation without Stripe env (dynamic import after setting `PAYMENT_MODE`); the Telegram webhook route covering confirm, decline, double-tap, unknown chat id, bad secret, `/start` linking; the email decision endpoints; the reminder cron including the janitor pass; the admin confirm route.
- Manual E2E before client rollout: real bot, two linked managers, tap Confirm on one phone and watch the other phone's message update, verify back office state, audit entries, customer email.

## 12. Open items

- Bot display name/avatar per client (cosmetic, BotFather, at rollout).
- WhatsApp adapter later only if a client demands it; the original central-number + router design for it is preserved in this file's git history.
