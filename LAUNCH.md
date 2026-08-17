# FleetDesk — Go-Live Runbook

Everything needed to take the Phase 2 platform from this repo to a live site at
`app.fleetdesk.app`. Steps marked **[owner]** need accounts/keys only the owner has.

## 1. Provision managed services [owner]

| Service | What | Gives you |
|---|---|---|
| **Supabase** (or Neon) | Postgres database | `DATABASE_URL` = transaction pooler (`:6543`, add `?sslmode=require`) for runtime; `DATABASE_MIGRATION_URL` = direct connection (`:5432`) for migrations |
| **Upstash** | Redis (rate-limit store) | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| **Stripe** | Payments (test then live) | a **restricted** key `rk_...`, and a webhook signing secret `whsec_...` |
| **Resend** | Transactional email | `RESEND_API_KEY` `re_...`, and a verified sender domain for `EMAIL_FROM` |
| **Vercel** | Hosting | the deployment + cron |

## 2. Generate secrets

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -base64 32   # DATA_ENCRYPTION_KEY  (NEVER rotate without re-encrypting licence rows)
openssl rand -hex 32      # CRON_SECRET
```

## 3. Set environment variables in Vercel [owner]

From `.env.example` — every variable is validated at boot (the app refuses to
start if any required one is missing or weak):

- `NODE_ENV=production`, `APP_ORIGIN=https://app.fleetdesk.app`, `CORS_ALLOWED_ORIGINS=https://app.fleetdesk.app`
- `SESSION_SECRET`, `SESSION_TTL_SECONDS=86400`, `SESSION_IDLE_TTL_SECONDS=1800`
- `DATABASE_URL` (Supabase transaction pooler `:6543`, `?sslmode=require`), `DATABASE_MIGRATION_URL` (Supabase direct `:5432`; optional), `DATA_ENCRYPTION_KEY`
- `STRIPE_SECRET_KEY` (restricted), `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`, `EMAIL_FROM="FleetDesk <bookings@fleetdesk.app>"`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `CRON_SECRET`
- `TRUST_PROXY=true`  (Vercel overwrites `x-forwarded-for`, so per-client rate limiting works)

## 4. Database

Run these once with the env above loaded. `db:migrate` uses `DATABASE_MIGRATION_URL`
(the Supabase direct `:5432` connection) when set, otherwise `DATABASE_URL`. The
booking exclusion constraint's `btree_gist` extension is created by migration 0002,
so there is nothing to enable in the Supabase dashboard.

```bash
npm run db:migrate    # applies drizzle/ migrations (direct connection)
npm run db:seed       # settings, insurance tiers, add-ons, and the placeholder fleet
npm run admin:create -- owner@fleetdesk.app   # prints a one-time password; MFA is forced at first login
```

Then sign in at `https://app.fleetdesk.app/admin`, enrol your authenticator app,
and replace the placeholder fleet/prices under **Fleet & pricing**, set the real
**reservation fee / deposits / guardrails** under **Settings**, and publish the
**Rental terms / Cancellation / Privacy** policies under **Policies**.

## 5. Stripe webhook [owner]

In the Stripe dashboard add a webhook endpoint:
- URL: `https://app.fleetdesk.app/api/webhooks/stripe`
- Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
- Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.

Local testing: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`.

## 6. DNS [owner]

Point `app.fleetdesk.app` at Vercel (CNAME) and add the domain in the Vercel project.

## 7. Flip the Phase 1 site to live

In `~/Desktop/saltycodestudio-clients/fleetdesk-rental/site/data/config.js` set
`bookingEnabled: true`. Every CTA on the marketing site then deep-links into this
app, and the footer policy links resolve to the published policies. Re-deploy the
static site.

## 8. Pre-launch smoke tests

- [ ] `curl https://app.fleetdesk.app/api/health` → `{"status":"ok","db":true}`
- [ ] Admin: login → MFA → edit a vehicle, change the reservation fee, publish a policy → see them in the audit log.
- [ ] Customer: open `/book`, get a quote, fill the licence, **pay with a Stripe test card** (4242 4242 4242 4242), land on the confirmation, and watch it flip to **confirmed** when the webhook lands.
- [ ] Confirm the booking appears (blue) on the admin **Planning board**.
- [ ] Customer: sign in at `/account/login` (real email via Resend now), see the booking, cancel it, confirm the slot frees up.
- [ ] Check `email_log` shows `sent` rows (login code, booking confirmed, admin alerts).
- [ ] The cron fires: Vercel → Cron → `/api/cron/expire-holds` runs every 15 min.
- [ ] Desk-mode clients only: `/api/cron/approval-reminders` is also
      registered (Vercel → Cron) and `CRON_SECRET` is set. Without it,
      unanswered approval requests never get their reminder ping, no matter
      what the reminder interval under **Settings > Booking approvals** says.

## 9. Security checklists (fort) before go-live

Run each relevant checklist in `~/Desktop/saltycodestudio-fort/checklists/`:
`auth-checklist`, `ecommerce-security`, `api-security-checklist`,
`deployment-hardening`, `secrets-and-env`, `owasp-top-10`.

## What this build already enforces

- Argon2id admin auth + mandatory TOTP MFA + account lockout + hardened sessions
- Postgres exclusion constraint = no double-booking AND turnaround buffer, even under a race
- Server-computed prices snapshotted on every booking; Stripe handles all card data
- Idempotent, signature-verified webhooks; one charge per booking; unpaid holds expire
- AES-256-GCM (AAD-bound) encryption of licence number + DOB, with a retention timer
- Passwordless customers, owner-scoped data, CSRF on every mutation, audit log on every admin action
- Strict CSP (API) + app CSP with clickjacking protection (pages), HSTS, secure headers
- Rate limiting (Upstash Redis across instances when configured)

## Known follow-ups (owner decisions / later)

- Refund handling on cancellation (spec §16): decide whether the reservation fee is refundable or credited.
- Pre-pickup reminder + low-stock email (scheduled jobs — add to vercel.json crons).
- CSP hardening: move script-src to a per-request nonce + `strict-dynamic` (currently `'unsafe-inline'`).
- Real fleet photos to private storage; automated ID verification (e.g. Stripe Identity) if desired.

## Security hardening (from the 2026-06-27 red-team)

A four-round authorized pentest found the app **HELD** at the network/auth boundary: no remote or app-level path to customer PII, driver licenses, bookings, payments, leads, or admin. Bugs found were fixed and regression-tested (the test suite covers them). Two residuals are deployment decisions, NOT app-code vulnerabilities:

1. **Secrets at rest [owner].** `DATA_ENCRYPTION_KEY` and `SESSION_SECRET` must NOT live in a plaintext dotfile next to the database. With host read access, the license PII decrypts. In production: load these from a secret manager / KMS (envelope-encrypt the data key), never co-locate the key with the encrypted store, restrict the runtime user, and rotate any secret that ever sat in a dev `.env`.
2. **Rate limiter needs a real client IP [owner].** With `TRUST_PROXY=false` and no Redis, the limiter keys on a spoofable request fingerprint (User-Agent), so per-IP global/auth limits can be evaded by rotating the header (DoS / abuse only; per-account lockout and per-email caps still hold). In production: run behind a trusted edge with `TRUST_PROXY=true` AND configure `UPSTASH_*` so it keys on the real IP across instances. The app logs a boot warning if neither is set.

Fixed in code (verified live + tests): the login API no longer returns the OTP (was a critical account-takeover leak); a fail-closed CSRF Origin guard now covers all guest state-changing POSTs (`/api/bookings`, `/api/bookings/[id]/checkout`, `/api/early-access`); the per-email login limit is keyed independent of the spoofable fingerprint (stops email-bombing).

## Desk mode + Telegram approvals (per client)

Some clients take payment at the desk instead of online. The booking wizard
stays the same, the customer just pays when they pick up the car, and a
manager confirms the booking from their phone (or the admin) before it locks
in.

1. **Turn on desk mode.** Set `PAYMENT_MODE=desk` on the deployment. Stripe
   is not required in this mode: `STRIPE_SECRET_KEY` and
   `STRIPE_WEBHOOK_SECRET` can be removed from the environment. Env is
   validated once at process boot, so changing `PAYMENT_MODE` (either
   direction) needs a fresh deploy before it takes effect, an env var edit
   alone does nothing until the next boot.
2. **Create the bot [owner].** In Telegram, message **BotFather** and run
   `/newbot`. Pick a name like `<Client> Bookings` (for example, `Little
   John Bookings`) and copy the token it gives you. Then set:
   - `TELEGRAM_BOT_TOKEN`, the token from BotFather.
   - `TELEGRAM_BOT_USERNAME`, the bot's `@username`, without the `@`.
   - `TELEGRAM_WEBHOOK_SECRET`, a fresh secret from `openssl rand -hex 24`.
3. **Point the webhook at this deployment.** Deploy with the three vars
   above set, then run:

   ```bash
   npm run telegram:setup
   ```

   This registers the webhook at `APP_ORIGIN/api/webhooks/telegram` with the
   secret, so every update Telegram sends can be trusted (it echoes the
   secret back in the `X-Telegram-Bot-Api-Secret-Token` header).

   `npm run telegram:setup` runs on YOUR machine and reads your LOCAL
   `.env.local`, not the deployment's environment. It needs
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` matching what you set
   on the deployment, and `APP_ORIGIN` pointed at the LIVE https deployment
   URL, not `localhost`, for example:

   ```
   TELEGRAM_BOT_TOKEN=123456:AA-the-same-token-you-set-on-the-deployment
   TELEGRAM_WEBHOOK_SECRET=the-same-secret-you-set-on-the-deployment
   APP_ORIGIN=https://app.fleetdesk.app
   ```

   The script also boots `src/env`, which validates the WHOLE environment
   schema, so `.env.local` needs to be otherwise valid too (a real
   `DATABASE_URL`, `SESSION_SECRET`, `DATA_ENCRYPTION_KEY`, and so on), not
   just these three Telegram variables.
4. **Add managers.** In the admin, go to **Settings > Booking approvals**,
   add each manager by name (and email, for the fallback channel), then
   **save the settings page**. Only after that save, copy each manager's
   invite link and send it to them. Tapping it opens `t.me/<bot>?start=<code>`
   in Telegram and their row flips from a bare invite link to a **Linked**
   tag. A link copied before the save does not exist server-side yet: the
   manager's tap gets the polite "staff only" denial instead of linking, not
   a broken link, so it is easy to miss during a rushed setup. Email still
   works as a fallback for a manager who never links Telegram, as long as
   their email is filled in on their row. Links are first-tap-wins: once a
   manager is Linked, their invite link is dead for every other Telegram
   account. If someone switches Telegram accounts, remove their row, save,
   re-add them, save again, and send the fresh invite link.
5. **Manual E2E checklist.** Run this once per client before handing the
   keys over:
   - [ ] Place a test booking on the live site.
   - [ ] Both linked managers get the ping on Telegram, including the fleet
         check line (how many of that vehicle class are free on those
         dates).
   - [ ] Tap **Confirm** on one manager's phone.
   - [ ] The other manager's message updates in place to
         `Confirmed by <name>`.
   - [ ] The booking shows confirmed in the admin.
   - [ ] The customer confirmation email arrived.
   - [ ] A second tap, from either manager, answers `already handled` and
         does not double-confirm or double-decline.
   - [ ] The buttons in the email fallback open the review page
         (`/approve/<token>`) and also report `already handled` once the
         booking has already been decided.
   - [ ] The admin's **Confirm booking** button shows up on the booking
         drawer (desk mode only: it stays hidden in online mode, and the
         route itself refuses to run outside desk mode).
   - [ ] Leave one booking unanswered. After the reminder interval (4 hours
         by default) it gets exactly one reminder ping; both numbers live
         under **Settings > Booking approvals**.
6. **Good to know.**
   - Bookings never auto-cancel in desk mode. An unanswered request just
     stays pending, the approval loop is a convenience, never a gate.
   - The reminder interval and the reminder count are both editable in
     Settings, so a client who wants faster follow-ups can turn the dial
     themselves.
   - The admin's Confirm button works whether or not Telegram is linked.
     Chat is one way in for managers, not the only way in.
