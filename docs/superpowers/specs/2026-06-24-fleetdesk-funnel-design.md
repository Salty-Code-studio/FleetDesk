# FleetDesk funnel site — design spec

**Date:** 2026-06-24 · **Repo:** `~/Desktop/saltycodestudio-products/fleetdesk` · **Branch:** `feat/marketing-funnel`

## Goal
A public marketing funnel for **FleetDesk** (booking + ops SaaS for small car-rental operators), built as **integrated Next.js routes inside the existing app**, landing on a **book-a-demo / early-access waitlist** capture. True self-serve signup needs the unbuilt multi-tenant + Stripe Billing work, so the funnel captures leads now and flips to real signup later.

## Two settled decisions
1. **Delivery = integrated Next.js routes** (a `(marketing)` route group inside `src/app`), not a standalone static site.
2. **Primary CTA = book-a-demo / early-access form** that stores leads. No real checkout.

---

## Architecture

### Route group
- New group `src/app/(marketing)/` with its own `layout.tsx` (site header + footer + fonts + `marketing.css`).
- Pages:
  - `src/app/(marketing)/page.tsx` → **home / funnel**, owns `/`.
  - `src/app/(marketing)/pricing/page.tsx` → `/pricing`.
  - `src/app/(marketing)/early-access/page.tsx` → `/early-access` (+ `early-access-form.tsx`, a `"use client"` form).
- **Delete the existing `src/app/page.tsx`** (the "Hardened API Starter" placeholder) so the marketing group owns `/`. Leave the root `src/app/layout.tsx` as-is (minimal `<html><body>`); the marketing layout nests inside it.
- Admin (`/admin`) and public booking (`/book`) are untouched and must keep working.

### Fonts — CSP-critical
The app's middleware stamps a strict UI CSP: `font-src 'self'`, `style-src 'self' 'unsafe-inline'`, `connect-src 'self'`, `script-src 'self' 'unsafe-inline'` (no `unsafe-eval` in prod), `img-src 'self' data: blob:`. **External font/CSS/script loads are blocked.** The admin's `@import url(fonts.googleapis.com...)` is actually silently blocked under this CSP — do NOT copy that pattern.
- Load fonts with **`next/font/google`** (self-hosts at build time, served from `'self'`, injects inline `@font-face`): `Space_Grotesk`, `JetBrains_Mono`, `Inter`, each with `subsets:["latin"]`, `display:"swap"`, and a CSS `variable` (`--font-display`, `--font-mono`, `--font-body`). Apply the combined `.variable` classNames to the marketing wrapper element in the `(marketing)` layout (scoped — do not pollute `/admin`).

### Styling
- One stylesheet `src/app/(marketing)/marketing.css`, imported only by the marketing layout.
- **Namespace everything under a `.mkt` root class** (the marketing layout wraps children in `<div className="mkt ...font vars">`). No bare `body`/`h1` global selectors that could bleed into admin/public chunks. Reset/base styles target `.mkt` and its descendants.
- Reuse the exact **Sand & Surf** palette (below). One Surf Coral accent per view. Sand + Teal carry ~90% of every layout. Sky Blue is supporting only.

### Motion — CSP-safe, zero deps
- No GSAP / no eval / no external JS. Scroll-reveal via a tiny `"use client"` component `src/app/(marketing)/reveal.tsx` using `IntersectionObserver` that toggles a class; transitions done in CSS. Respect `prefers-reduced-motion`.

---

## Brand tokens (Sand & Surf)
```
--warm-sand   #F2EBDD   canvas
--sand-2      #EAE0CD   deeper sand / hover tints
--panel       #FCFAF4   warm near-white surfaces
--deep-teal   #0E3A40   primary ink / headings / buttons
--teal-700    #0A2C31   button hover
--surf-coral  #FF6F59   THE accent — one emphasis per view
--coral-600   #F2563F   coral hover
--sky-blue    #4FA8C9   secondary accent (tags, supporting)
--ink         #1C2B2E   driftwood text
--ink-soft    #586A6D   muted
--line        #E3DAC8   warm sand border
```
- Type: **Space Grotesk** display (tight tracking ~-2%), **JetBrains Mono** for eyebrows/labels/numbers (UPPERCASE, letterspaced), **Inter** body.
- Logomark: `~<` (tilde-as-swell + code bracket). Wordmark: `FleetDesk` set in Space Grotesk 600. On teal surfaces, mark in Warm Sand; on sand, mark in Deep Teal.
- Voice: confident, plainspoken, a little salty. Short sentences. No buzzwords. Tagline feel: "Clean code, warm coast."
- **HOUSE RULE: no em-dashes (— or --) anywhere in copy.** Use periods or commas.

---

## Backend — lead capture (mirror existing house patterns exactly)

### Schema: `src/lib/db/schema/leads.ts`
Mirror `customers.ts` style (`pgTable`, `uuid().defaultRandom().primaryKey()`, `timestamp({withTimezone:true}).defaultNow()`).
```ts
export const earlyAccessLeads = pgTable("early_access_leads", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),            // store lowercased
  company: text("company").notNull().default(""),
  country: text("country").notNull().default(""),
  fleetSize: text("fleet_size").notNull().default(""),
  message: text("message").notNull().default(""),
  source: text("source").notNull().default("early-access"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```
Add `export * from "./leads";` to `src/lib/db/schema/index.ts`.

### Migration
Run `npm run db:generate` (drizzle-kit) to produce `drizzle/0014_*.sql`, then `npm run db:migrate` to apply to the local PGlite `.dev-db`. Verify the table exists. Non-interactive for a new table.

### Route: `src/app/api/early-access/route.ts`
Mirror `src/app/api/quote/route.ts`. Use `withRoute`, `enforceRateLimit(req, "global", "public")`, `parseJsonBody(req, Schema)`, `getDb()`, `json(...)`.
```ts
export const runtime = "nodejs";
const BodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  company: z.string().trim().max(160).optional().default(""),
  country: z.string().trim().max(80).optional().default(""),
  fleetSize: z.enum(["1-5","6-10","11-25","26-50","50+"]).optional().default(""),
  message: z.string().trim().max(2000).optional().default(""),
  // honeypot: real users never fill this; bots do.
  website: z.string().max(0).optional().or(z.literal("")),
}).strict();
```
- On success: insert (email lowercased), return `json({ ok: true }, req, { status: 201 })`.
- If the honeypot `website` is non-empty: return `json({ ok: true }, req, { status: 201 })` WITHOUT inserting (don't tip off bots).
- Validation is enforced by `parseJsonBody` (it throws a safe 422). Rate-limit before parsing.
- Add a vitest test (`src/test/early-access.test.ts`) covering: valid insert (201 + row written), invalid email (422), honeypot trip (201, no row). Follow the existing test style; run with `--no-file-parallelism`.

### Email notification — OUT OF SCOPE for v1
Leads land in the DB. A future admin "Leads" view + email-on-new-lead (via existing `sendAndLog`) is roadmap, not this build. Do not invent env/recipients.

---

## Frontend — pages & content

Quality bar: **premium, editorial, anti-generic.** Vary section rhythm (do NOT make every section left-text/right-visual). Generous vertical spacing. Strong type scale contrast. One coral accent per view. Fully responsive (mobile-first, test ~375px and ~1280px). Accessible: semantic landmarks (`header/main/section/footer`), labelled form fields, visible focus states, alt text, sufficient contrast.

### Marketing layout (header + footer)
- Sticky-ish header: `~<` mark + `FleetDesk` wordmark · nav links (Features → home anchor, Pricing → `/pricing`) · "Log in" (→ `/admin`) · **"Request access"** primary coral button (→ `/early-access`). Collapses cleanly on mobile.
- Footer: wordmark + one-line pitch, small nav, "Made by saltycodestudio", year. Teal surface, sand text. No fake social/legal links that 404 (use real or omit).

### `/` — home / funnel (single narrative scroll)
1. **Hero** — eyebrow (mono, e.g. `BOOKING + OPS FOR CAR RENTAL FLEETS`), big headline, subhead, primary CTA "Request early access" + secondary "See it live" (→ `/book`). Hero visual: a CSS-built product frame (see below), not an external image. Make the hero spacious and readable on a small laptop.
2. **Trust strip** — honest credibility line, e.g. "Built from a working island rental operation." Small set of value chips (No double-bookings · Online booking · One ops desk). No fake company logos.
3. **Problem → solution** — the spreadsheet/WhatsApp/paper chaos vs. one desk. Short, punchy.
4. **Feature bento** — gapless bento grid, varied tile sizes:
   - *Online booking, 24/7* — Customers book and pay online. You wake up to confirmed reservations.
   - *Never double-books* — A database-level guarantee, not a checkbox. Two bookings can never hold the same car on overlapping dates.
   - *Live fleet calendar* — Every car, reservation, maintenance window and blackout on one planning board.
   - *Instant, accurate quotes* — Server-computed pricing with insurance tiers and add-ons. The price is always right.
   - *Customer records & licenses* — Encrypted driver's-license capture, booking history, repeat-customer recognition.
   - *Reports that mean something* — Utilization, revenue and fleet performance without exporting to a spreadsheet.
5. **How it works (3 steps)** — 1) Load your fleet (we help you import). 2) Share your booking page (put it on your site or send the link). 3) Run it from one desk (approve, plan, track).
6. **Product peek** — a CSS-rendered mock of the Sand & Surf admin (a stylized planning board / booking row using the real tokens). Self-contained, same-origin, no external asset. Leave it standalone so a real screenshot can swap in later.
7. **Pricing teaser** — three tiers at a glance + "See full pricing" → `/pricing`.
8. **FAQ** — accordion or simple list (see FAQ below; use a subset on home, full set on pricing).
9. **Final CTA band** — coral or teal band, "Run your fleet from one desk." → "Request early access".

### `/pricing`
- Three cards: **Starter €99/mo** (up to 10 cars; online booking, fleet calendar, quotes, customer records) · **Pro €249/mo** (up to 40 cars; everything in Starter + maintenance/blackouts, reports, notifications, multi-user; tag "Most operators start here") · **Business €449/mo** (unlimited cars, multi-location, custom domain, priority support).
- Below cards: **Setup €500–750** one-time (we load and brand your fleet). **Annual = 2 months free.** **Early-adopter: about 30% off, locked for life.** All prices in EUR.
- Honest framing on roadmap items: card payments are "through Stripe"; an embeddable booking widget is "coming" (do not claim it ships today).
- Pricing FAQ (full set below). Final CTA → `/early-access`.

### `/early-access` — the funnel endpoint
- Short, reassuring intro: what early access means (we onboard you personally, load your fleet, lock early-adopter pricing).
- Form (`early-access-form.tsx`, client component): **name, work email, rental business name, country, fleet size** (select: 1-5 / 6-10 / 11-25 / 26-50 / 50+), **optional message**, hidden honeypot `website` field. Inline validation; disabled-while-submitting; POST JSON to `/api/early-access`.
- Success state replaces the form: "You're on the list. We'll be in touch within 2 business days." Error state: friendly retry message.
- Trust line under the form: monthly, cancel anytime, export your data.

### FAQ content (use subset on home, full on pricing)
- **Do my customers need an app?** No. They book in the browser. Nothing to download.
- **Can I keep my own website?** Yes. Link to your FleetDesk booking page today. An embeddable widget is coming.
- **What about payments?** Card payments run through Stripe.
- **Is my data safe?** Driver's licenses are encrypted, security headers are hardened, and actions are audit-logged.
- **How fast can I launch?** Days, not months. We load your fleet during setup.
- **Can I cancel?** Monthly billing, cancel anytime, and you can export your data.

---

## Non-goals (explicitly out)
- No real self-serve signup, plan selection, or Stripe checkout (needs unbuilt multi-tenant + Billing).
- Not restyling the public `/book` flow (separate task).
- No blog/MDX, no external scheduling embed (CSP), no fake logos or 404 links.
- No admin "Leads" view or lead-notification email (roadmap).

## Verification (must all pass, no dev server running during build)
1. `npm run typecheck` — clean.
2. `npm run lint` — clean.
3. `npm test -- --no-file-parallelism` — all green (incl. new early-access test). 185 existing tests must stay green.
4. `npm run build` — succeeds (NEVER while `next dev` is live; kill dev + `rm -rf .next` if corrupted).
5. CSP audit — no external font/script/style/img loads; fonts via next/font; motion via IntersectionObserver; form posts same-origin.
6. Design/brand audit — anti-generic, one coral accent per view, no em-dashes, responsive at 375px + 1280px, a11y basics.

## Gotchas (from prior sessions)
- `node_modules` is a symlink to the Tex app's; it's present (Next 15.3.3).
- NEVER run `npm run build` while `next dev` is live (shared `.next` corrupts). Stop dev first.
- Run tests with `--no-file-parallelism`.
- Local Stripe keys are dummy; checkout won't really run (irrelevant here, no checkout).
