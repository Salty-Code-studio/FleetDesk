# FleetDesk

**The booking + operations platform for small rental operators.** A complete,
production-grade rental booking engine and admin ops console that an operator can
run as their whole back office: customers reserve a vehicle online and pay, while
the operator manages fleet, prices, availability, payments and bookings from a
single hardened admin portal.

Built by [saltycodestudio](https://github.com/Salty-Code-studio) on its reusable
booking/ops framework and [fort](https://github.com/Salty-Code-studio/saltycodestudio-fort)
security patterns. First proven in production for a car-rental operator; this repo
is the **generic, multi-tenant-ready product** (demo data only — no customer data).

> Commercial product. Operators pay a monthly subscription to run their booking
> portal on FleetDesk.

---

## What it does

**Customer side (public booking flow)**
- Browse vehicle **types/classes**, get a live, server-computed quote (tiered
  daily / weekly / monthly — always the cheapest decomposition).
- Pick dates, add insurance tiers and extras (with real stock limits), enter
  driver details, and pay a reservation fee or deposit via **Stripe Checkout**.
- Passwordless account (email OTP) to view, manage and cancel bookings.

**Operator side (admin ops portal)**
- **Planning board** — an Excel-style fleet calendar: drag bookings to move dates
  or reassign vehicles, create manual/walk-in bookings, block cars for
  maintenance. Re-prices and re-checks stock on every move.
- **Fleet & pricing**, **add-ons & insurance**, **policies** (versioned),
  **settings** (fees, deposits, guardrails, blackout dates) — all editable, no
  redeploy.
- **Notifications** — in-app bell + owner email/WhatsApp alerts on new bookings
  and payments.
- **Audit log** on every change; **reports** on revenue and utilisation.

## Why it's safe to run a real business on

- No double-booking, ever: a Postgres **exclusion constraint** makes overlapping
  reservations (with a turnaround buffer) physically impossible, even under a race.
- Server-computed prices **snapshotted** on every booking; Stripe handles all card
  data; **idempotent, signature-verified** webhooks; one charge per booking.
- **Argon2id** admin auth + mandatory **TOTP MFA** + account & MFA lockout;
  passwordless customers; CSRF on every mutation; strict CSP + secure headers.
- **AES-256-GCM** encryption of driver-licence PII with a retention timer.
- Rate limiting (Upstash Redis across instances), fail-closed env validation.

## Stack

| Concern     | Choice |
| ----------- | ------ |
| Framework   | Next.js 15 (App Router, Route Handlers) · TypeScript strict |
| Database    | PostgreSQL (Supabase / Neon) via Drizzle ORM; PGlite for local/dev/test |
| Payments    | Stripe Checkout + webhooks |
| Email       | Resend (optional) |
| Rate limit  | Upstash Redis (optional; in-memory fallback) |
| Hosting     | Vercel (Dockerfile included for self-host) |
| Tests       | Vitest (185 tests) |

## Quick start

```bash
npm install
cp .env.example .env.local      # fill in secrets; every var is validated at boot
npm run db:migrate              # PGlite locally (pglite://.dev-db), Postgres in prod
npm run db:seed                 # settings, insurance tiers, add-ons, a demo fleet
npm run admin:create -- you@example.com   # prints a one-time password; MFA forced on first login
npm run dev                     # http://localhost:3000  ( /book · /admin )
```

`npm test` · `npm run typecheck` · `npm run lint` · `npm run build`.

## Going live

See [`LAUNCH.md`](./LAUNCH.md) for the full runbook (Supabase, Stripe webhook,
Resend, Upstash, Vercel + cron, DNS, smoke tests).

## Productisation roadmap (toward multi-tenant SaaS)

This repo is the single-tenant platform, generalised. To run it as a hosted
multi-tenant SaaS, the main work is:
- **Tenancy** — an `operators` table + tenant scoping on every query (or schema /
  database per tenant), tenant-aware admin auth and routing.
- **Onboarding & billing** — operator sign-up, Stripe **Connect** for operator
  payouts, and a subscription (Stripe Billing) for the FleetDesk monthly fee.
- **Theming** — per-operator branding (name, logo, colours, languages, currency).
- **Provisioning** — per-tenant domain/subdomain, seed, and admin bootstrap.

---

© saltycodestudio. Proprietary. Not for redistribution.
