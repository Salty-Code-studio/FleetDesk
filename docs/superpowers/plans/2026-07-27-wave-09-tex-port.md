# Tex Cars Port (Wave 09) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Tex Cars client app to full parity with FleetDesk: the four security fixes, the Sand & Surf admin kit + redesign, the booking wizard, and the entire 2026-07 feature wave (waves 01-08), plus Tex-specific data and config tasks — without touching Tex's real fleet seed, branding, or env identity.

**Architecture:** The two repos have no shared git ancestry, but FleetDesk's initial commit is a byte-level snapshot of Tex's current HEAD, so FleetDesk commits apply onto Tex with `git apply`/`git am` mostly cleanly. This plan ports commit ranges in dependency order, resolves the known conflict classes (branding strings, env.ts, the `(marketing)` route-group move, seeds), renumbers wave migrations for Tex, then applies Tex data tasks and gates on the full Tex test suite plus a manual smoke.

**Tech Stack:** git apply/am across unrelated repos, Next.js 15, drizzle migrations, vitest.

## Global Constraints

- Tex repo: `/Users/monischahieroms/Desktop/SaltyCode/03-Clients/saltycodestudio-clients/tex-cars-rental/app` (its OWN git repo; commit there, never to the FD repo). FD repo: `/Users/monischahieroms/Desktop/SaltyCode/04-Products/saltycodestudio-products/fleetdesk`, branch `feat/wave-2026-07`.
- Tests in Tex: `npm test -- --no-file-parallelism`. NEVER `npm run build` while a dev server runs.
- PROTECTED Tex files — never overwritten by a bulk copy, only hand-merged: `scripts/seed.ts` (real 34-car fleet), `scripts/seed-demo-bookings.ts`, `src/env.ts` (Tex EMAIL_FROM + demo block), `vercel.json` (Tex cron cadence `*/15`), all Tex branding strings, `.env.local`.
- SKIPPED FD content (SaaS-only, never ported): marketing funnel commit `a288900`, `f525d5a` (early-access CSRF), `src/lib/db/schema/leads.ts`, migration `0014_hot_mesmero.sql`, `src/app/(marketing)/` pages, the demo-door commit `5af8b32` unless the owner asks for a Tex demo.
- Copy stays dash free. All wave seam names identical to FD (`docs/superpowers/plans/SEAMS-2026-07-wave.md` in the FD repo).
- Work in Tex on a new branch: `feat/parity-2026-07`.

## Conflict playbook (applies to every apply step)

When `git apply --3way` leaves conflicts, resolve by file class:
1. **Branding strings** (layout metadata, email FROM/shell header, "Back to …" links, product fallback names): keep the TEX value. After wave 02's site-config port, these become env-driven — prefer deleting the hardcoded string in favor of `siteConfig`.
2. **`src/env.ts`**: hand-merge — take FD's structural additions (new env vars) but keep Tex's `EMAIL_FROM`, demo block, and any Tex-specific defaults.
3. **`src/app/page.tsx` vs `(marketing)` route group**: Tex keeps its own `src/app/page.tsx` (the Tex app landing); NEVER create `(marketing)` in Tex. Drop hunks that move/create marketing pages.
4. **Rewritten-file conflicts** (`book/page.tsx`, `admin.css`, `public.css`, admin pages): whole-file copy FROM FD, then re-apply Tex branding by grepping the copied file for `FleetDesk|fleetdesk` and replacing with the Tex equivalents (after wave 02 these should be zero besides comments).
5. **Migrations**: never apply FD migration files by patch. Copy the SQL file, renumber to Tex's next journal number, and let `npm run db:generate`-produced journal entries stay consistent (see Task 4 Step 3).
6. **Seeds**: drop every hunk touching `scripts/seed.ts` / `seed-demo-bookings.ts`; hand-apply only structural schema-driven changes Tex's seed needs (Task 6 does this deliberately).

---

### Task 1: Branch, remote link, and baseline green

**Files:** none modified; setup only.

**Interfaces:**
- Produces: Tex branch `feat/parity-2026-07`; git remote `fleetdesk` inside the Tex repo; a recorded FD commit list to port.

- [ ] In the Tex repo: `git checkout -b feat/parity-2026-07` (from its current HEAD, `d8fbcd1` or later).
- [ ] `git remote add fleetdesk /Users/monischahieroms/Desktop/SaltyCode/04-Products/saltycodestudio-products/fleetdesk && git fetch fleetdesk` — expected: `feat/wave-2026-07` and its history become visible as `fleetdesk/feat/wave-2026-07`.
- [ ] Baseline: `npm test -- --no-file-parallelism` → expected ~186 tests green BEFORE any change. If red, STOP and fix the baseline first (do not port onto a red base).
- [ ] Record the port list: `git log --oneline --reverse fleetdesk/feat/wave-2026-07` and save the full list to `docs/PORT-LOG.md` in the Tex repo with three columns: hash, subject, decision (`port` / `skip` / `hand-merge`). Pre-fill decisions: `a288900` skip, `f525d5a` skip, `5af8b32` skip, docs-only commits (`8c0cfc8`, spec/plan commits) skip; everything else port in order.
- [ ] Commit: `git add docs/PORT-LOG.md && git commit -m "chore(port): parity branch, fleetdesk remote, port ledger"`

---

### Task 2: Security fixes + Next.js line (independent, highest urgency)

**Files:**
- Modify (via apply): `src/lib/http/rate-limit.ts`, auth OTP routes/lib, CSRF module + guest booking/checkout routes, `package.json` + lockfile
- Test: FD's regression tests come along (`auth-otp-no-leak.test.ts`, `rate-limit-perscope.test.ts`)

**Interfaces:**
- Consumes: FD commits `32b6ea4` (OTP-leak account takeover + guest CSRF), `1e0c855` (per-victim rate-limit cap), `713c11c` (Next 15.3.3 → 15.5.20).
- Produces: Tex is no longer exposed to the four red-team findings; Next security line current.

- [ ] `git cherry-pick -n 32b6ea4` (the `-n` stages without committing so conflicts resolve calmly). Resolve per the playbook (expected: near-clean). Run the two new test files + full suite → green. Commit: `git commit -m "fix(security): OTP-leak account takeover closed + CSRF origin guard on guest booking/checkout (port 32b6ea4)"`
- [ ] `git cherry-pick -n 1e0c855`, resolve, suite green, commit `"fix(security): per-victim rate limits independent of spoofable fingerprint (port 1e0c855)"`.
- [ ] Next upgrade: do NOT patch package.json blindly. In Tex run `npm install next@15.5.20 eslint-config-next@15.5.20`, then `rm -rf .next && npm run build` (dev server stopped) → build succeeds; full suite green. Commit `"fix(security): Next.js 15.3.3 -> 15.5.20 secure backport line (port 713c11c)"`.
- [ ] Update `docs/PORT-LOG.md` decisions column; commit.

---

### Task 3: Admin kit + Sand & Surf admin + booking wizard (pre-wave FD improvements)

**Files:**
- Create (whole-file copies): `src/app/admin/_ui/**`, `src/components/ui/**` (DatePicker, Select + CSS), `src/app/admin/(shell)/side-nav.tsx`, per-page admin CSS files
- Modify: all `src/app/admin/(shell)/*/page.tsx`, `src/app/admin/admin.css`, `src/app/(public)/book/page.tsx` + book CSS, `src/app/(public)/public.css`
- Test: full suite

**Interfaces:**
- Consumes: FD commits `369502f`, `2344d3e`, `72f563d`, `a7ef368` — but per the divergence analysis these files were REWRITTEN, so whole-file copy beats patching.
- Produces: Tex admin/public UI byte-matches FD's pre-wave state modulo branding; the wave commits (Task 4) then apply nearly clean.

- [ ] Copy the directories/files listed above FROM the FD repo at commit `713c11c` (the last pre-wave commit): use `git -C <FD> show 713c11c:<path>` redirected into the Tex working tree for each file, or check out that revision to a temp dir and `rsync` the exact list. Do NOT copy: anything under `(marketing)`, `src/lib/db/schema/leads.ts`, `src/app/admin/(shell)/page.tsx`'s FD-demo bits if the demo commit was skipped (grep for `DEMO_MODE` and drop those blocks), seeds, env.ts.
- [ ] Re-brand the copied files: `grep -rn "FleetDesk\|fleetdesk" <copied files>` and replace user-visible strings with Tex equivalents ("Tex Cars", `tex-cars.com` back-links, Tex email shell header). Record each replacement in `docs/PORT-LOG.md`.
- [ ] `npx tsc --noEmit` → drain errors (usually missing imports the copies expect — copy those too and log them).
- [ ] Full suite → green (FD's suite at 713c11c had ~199 tests; Tex now needs FD's test files for the copied features: copy `src/test/` files that cover the copied UI/libs, EXCLUDING early-access/demo tests).
- [ ] Manual: Tex dev server — `/admin` shows the Sand & Surf shell with Tex branding; `/book` runs the step wizard end to end.
- [ ] Commit: `git commit -am "feat(admin+book): port FleetDesk Sand & Surf admin kit, admin redesign, booking wizard (369502f, 2344d3e, 72f563d, a7ef368)"`

---

### Task 4: Port the feature wave (waves 01-08) in order

**Files:** everything the wave touched; migrations renumbered.

**Interfaces:**
- Consumes: every FD wave commit on `feat/wave-2026-07` after the docs commits, in original order (the per-wave commit messages all start with `feat(`/`fix(` and are listed in the Task 1 ledger).
- Produces: Tex has time-aware booking, payments redesign + extensions, compliance alerts, fleet upgrades, young-driver surcharge, check-in/out, reports, staff logins.

- [ ] Port wave by wave, commit group by commit group. For each FD wave commit in order: `git cherry-pick -n <hash>` → playbook resolution → targeted tests for that wave (`npm test -- --no-file-parallelism src/test/<wave-related-files>`) → `git commit` reusing the FD commit subject + ` (port <hash>)` suffix. After each WAVE completes (not each commit), run the FULL suite. Do not start the next wave on a red suite.
- [ ] Migration renumbering rule (applies within each wave): FD wave migrations arrive with FD numbering (0015+). In Tex, for each ported migration file: copy the SQL body into a fresh `npm run db:generate`-created file when the change is schema-TS-derivable, or hand-create the next-numbered file + journal entry following the FD file's exact SQL when it is hand-written (the tstzrange constraint, enum surgery). Verify after each wave: `DATABASE_URL=pglite://.migration-smoke npm run db:migrate && rm -rf .migration-smoke` → clean.
- [ ] Wave 02 note: after its site-config commit lands, set Tex's public brand via env instead of strings — add to `.env.local` (and `docs/` deploy notes): `NEXT_PUBLIC_SITE_NAME="Tex Cars"`, `NEXT_PUBLIC_SITE_URL="https://tex-cars.com"`, `NEXT_PUBLIC_WHATSAPP_NUMBER=<owner's number from site/data/config.js>`. Remove any leftover hardcoded Tex strings the Task 3 re-brand added where siteConfig now serves them.
- [ ] Wave 03 note: `vercel.json` hand-merge — KEEP Tex's `*/15` expire-holds schedule and ADD the daily compliance cron alongside.
- [ ] Wave 06 note: contract PDF operator block = Tex Cars details (name, tex-cars.com, owner contact). The FD code reads these from siteConfig + settings; verify no FleetDesk fallback renders in a generated Tex contract.
- [ ] Wave 08 note: staff login is new auth surface — verify Tex's existing owner account still logs in with password + TOTP after the port (use the local dev credentials in the project handoff docs).
- [ ] Update `docs/PORT-LOG.md` with every hash → decision → resolution note. Commit the log at each wave boundary.

---

### Task 5: Tex data tasks — A-plates retired, fleet identity backfill, settings

**Files:**
- Modify: `scripts/seed.ts` (hand-edit, protected file), `docs/PORT-LOG.md`
- Test: `npm run db:seed` on a scratch DB + full suite

**Interfaces:**
- Consumes: wave 04 vehicle columns (`make`, `model`, `year`, `color`), wave 03 compliance columns, vehicle `status: "retired"`.
- Produces: the production seed reflects the client's asks.

- [ ] In `scripts/seed.ts`: set `status: "retired"` for the four A-plate Suzukis — plates `A-71203`, `A-68405`, `A-21141`, `A-67530`. Do NOT delete the rows (history). Retired vehicles already disappear from the fleet default view, planning board, and public classes.
- [ ] Backfill `make`, `model`, `year`, `color` for every remaining vehicle in the seed by splitting the existing `name` values (e.g. name "Hyundai Accent" → make "Hyundai", model "Accent"; year/color from the client sheet where the seed has them in comments or names, else leave null and note it in PORT-LOG for the owner to fill in the admin).
- [ ] Tex settings in the seed's settings insert: `minDriverAge: 18`, `youngDriverAge: 21`, `youngDriverFeeCentsPerDay: 1000` (owner-adjustable), `cancellationWindowHours: 48`, `depositPercent: 25`, `depositMinCents: 3000`, `openingTime`/`closingTime` per the owner's hours from the marketing site (check `site/data/config.js` in the parent repo; default "08:00"/"18:00" when absent).
- [ ] Scratch-verify: `DATABASE_URL=pglite://.seed-smoke npm run db:seed && rm -rf .seed-smoke` → completes; then full suite → green.
- [ ] Commit: `git commit -am "chore(fleet): retire A-plate Suzukis, backfill make/model/year/color, wave settings defaults"`

---

### Task 6: Gate — full verification in Tex branding

**Files:** none new.

- [ ] `npm test -- --no-file-parallelism` → green (Tex suite now ≈ FD's count minus funnel/demo tests). `npx tsc --noEmit`, `npm run lint` → clean. Stop dev, `rm -rf .next`, `npm run build` → succeeds.
- [ ] Manual smoke on the Tex dev server (all in Tex branding, no "FleetDesk" visible anywhere — `grep -ri fleetdesk src/ | grep -v "^.*//"` should hit only comments):
  1. `/book`: wizard with pickup/return times, age selector, honest pay step, Stripe test redirect amount matches "You pay now".
  2. `/admin` planning board: fractional time bars, state colors, timed block, drag-move, advisory conflict dialog.
  3. BookingDrawer: payments + balance, refund, cancel with choice, extend by desk + link.
  4. Check-in a test booking (licence photo, walk-around, borg, signature) → contract PDF email; check-out with a damage flag.
  5. `/admin/fleet`: grouped classes, search, notes, compliance dates + badges; dashboard compliance card.
  6. `/admin/reports`: per-car matrix + monthly and yearly PDF downloads; borg panel separate from revenue.
  7. `/admin/staff`: create a staff code, log in with it in a private window, verify the audit log shows the person; confirm staff cannot open `/admin/settings`.
  8. Phase-1 deep link from the static site format (`/book?class=Economy&pickup=2026-08-20&return=2026-08-22`) still works.
- [ ] Fix anything found with `fix(...)` commits.
- [ ] Final: update `docs/PORT-LOG.md` status line to "parity complete", note the go-live env additions the owner's deployment needs (`NEXT_PUBLIC_SITE_*`, `STORAGE_DRIVER=supabase` + bucket, compliance cron), and commit `"docs(port): parity complete, go-live env notes"`.
- [ ] Do NOT merge to the Tex main branch or deploy — the branch is presented to Mo for the client hand-off decision.
