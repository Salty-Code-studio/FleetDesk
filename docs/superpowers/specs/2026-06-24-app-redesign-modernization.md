# FleetDesk app redesign + modernization — brief

**Date:** 2026-06-24 · **Repo:** `~/Desktop/saltycodestudio-products/fleetdesk` · **Branch:** `feat/marketing-funnel` (continuing)

## Goal (approved)
Bring the WHOLE app up to "salty code standards" (Sand & Surf) in one comprehensive pass, with a **full modern overhaul** of the admin UX. Two surfaces:
1. **Public booking flow** (`/book` etc.) is still the OLD blue/navy/orange palette. Rebrand to Sand & Surf.
2. **Admin** is on-brand by color but dated in interaction. Modernize: inline forms become click-to-open **modals**, add **toasts**, **confirm dialogs**, **loading skeletons**, **empty states**, a **command palette / keyboard shortcuts**, table polish, and tasteful micro-interactions on every screen.

## Non-negotiable constraints
- **Preserve ALL behavior.** This is a presentation + interaction-shell change. Do NOT change handlers, state logic, API calls, validation, or data flow. Move existing form JSX into a modal wrapper; keep the same `onSubmit`, state, and fetch calls. The 189 tests MUST stay green.
- **Strict CSP** (same as everywhere): fonts via `next/font` (NO external `@import`), `style-src 'self' 'unsafe-inline'` (inline styles + styled-jsx OK), `script-src 'self' 'unsafe-inline'` (NO eval libs), `img-src 'self' data: blob:`, `connect-src 'self'`. Motion via CSS + IntersectionObserver only.
- **House rule:** no em-dashes (no long dash, no `--`) in any visible copy.
- Match the proven marketing pattern (`src/app/(marketing)/layout.tsx`) for `next/font` self-hosting.

## Sand & Surf tokens (already in admin.css `:root`)
`--sand #F2EBDD` canvas · `--panel #FCFAF4` surfaces · `--teal #0E3A40` ink/primary · `--teal-700 #0A2C31` hover · `--coral #FF6F59` THE single accent per view · `--sky #4FA8C9` secondary · `--ink #1C2B2E` · `--line #E3DAC8`. Fonts: Space Grotesk (display), JetBrains Mono (labels/numbers/eyebrows, UPPERCASE letterspaced), Inter (body). Logomark `~<`. One coral accent per view; Sand + Teal carry ~90%. AA contrast required (coral buttons use deep-teal text, not white).

---

## TRACK A — Public booking flow to Sand & Surf
Files (restyle; keep all logic): `src/app/(public)/layout.tsx`, `public.css`, `book/page.tsx`, `book/confirmation/page.tsx`, `account/page.tsx`, `account/login/page.tsx`, `account/verify/page.tsx`, `policies/[type]/page.tsx`.
- **Fonts:** load Space Grotesk / JetBrains Mono / Inter via `next/font/google` in `(public)/layout.tsx` (mirror marketing), applied to a `.pub` wrapper. Remove any external font dependency.
- **public.css:** replace the blue/navy/orange tokens (`--blue #2348c7`, `--orange #f15f2c`, `--navy #15192f`) with Sand & Surf. Restyle: header (warm, `~<` mark + FleetDesk wordmark, keep the "We bring the car to you" tag or similar), the step cards (numbered steps in teal, coral only as the single accent e.g. the active selection / primary CTA), car-class rows, insurance radios, extras checkboxes, licence + details forms, the sticky Summary sidebar, the primary CTA button (deep-teal text on coral), date inputs. Confirmation, account login/verify, and policies pages all restyled to match.
- Warm, editorial, calm, trustworthy. Responsive (375px + 1280px). Fix any console error on `/book`. Keep the 6-step structure and all field names/handlers.

---

## TRACK B — Admin modern-UI kit (shared, build once)
New components under `src/app/admin/(shell)/_ui/` (or `src/app/admin/_ui/`):
- **`Modal.tsx`** (`"use client"`): accessible dialog. Props: `open`, `onClose`, `title`, `children`, optional `size`. Focus-trap, restore focus on close, `Escape` closes, backdrop click closes, `role="dialog"` + `aria-modal` + labelled by title, body scroll lock. Enter/leave transition (CSS). Build on the existing `.pl-modal` look but elevate it.
- **`Drawer.tsx`**: side panel variant (right-slide) for larger forms; same a11y as Modal. (Modal and Drawer may share a base.)
- **`Toast.tsx` + `ToastProvider` + `useToast()`**: context-based toasts (success / error / info), auto-dismiss, stacked, `aria-live="polite"`, dismissible. `useToast().show({ type, message })`.
- **`ConfirmDialog.tsx` + `useConfirm()`**: promise-based confirm ("Retire this vehicle?") with cancel/confirm, danger variant.
- **`Skeleton.tsx`**: shimmer placeholders for loading rows/cards (CSS animation, reduced-motion safe).
- **`EmptyState.tsx`**: icon/mark + title + hint + optional action button, for empty tables/lists.
- **`CommandPalette.tsx`**: `Cmd/Ctrl+K` opens a searchable action/navigation palette (jump to Fleet, Catalog, Reports, etc., and key actions like "Add vehicle"). Keyboard-first, a11y. No external deps.
- **Styles:** add a clearly-delimited section to `admin.css` (or a new `admin-ui.css` imported by the shell) for all kit components. Scoped, token-driven.

Shell wiring (`src/app/admin/(shell)/layout.tsx`): introduce a client `AdminChrome` wrapper that mounts `ToastProvider` + `CommandPalette` (and any confirm host) around `{children}` and the topbar, since the layout is a Server Component. Update the shell logo from `FLEET<b>DESK</b> Admin` to use the `~<` mark.

**Admin font fix (real bug):** `admin.css` currently loads fonts via a CSP-blocked `@import url(fonts.googleapis.com...)`, so Space Grotesk / JetBrains Mono do not actually render in admin. Replace with `next/font/google` (self-hosted) wired in the admin shell + auth layouts, and delete the `@import`. Verify the display font actually renders.

---

## TRACK C — Fleet section: the reference conversion
`src/app/admin/(shell)/fleet/page.tsx` (+ co-located css if needed; do NOT edit other sections' files):
- Replace the always-inline add/edit `<form className="panel">` with a **modal**. Add an **"Add vehicle"** button (in the section header) that opens the modal empty; row **"Edit"** opens the same modal pre-filled. KEEP the exact `f` state, `setF`, `save`, `edit`, `empty`, field names, and API calls; only relocate the JSX into `<Modal>`.
- Replace the inline `msg` feedback with **toasts** (`useToast`) on save/update/error.
- **Confirm dialog** before Retire/Delete (replace the bare `apiDelete`).
- **Loading skeleton** while the table loads; **empty state** when no vehicles.
- Table polish, row hover, status tag refinement, focus states. This page is the pattern every other admin section will follow.

---

## Verification (must pass; no dev server running during build)
1. `npm run typecheck` clean · `npm run lint` clean.
2. `npm test -- --no-file-parallelism` all green (189+).
3. `npm run build` succeeds.
4. CSP audit: no external font/style/script/img; next/font only; modal/palette JS is plain React (no eval).
5. Functional: booking flow still submits; fleet add/edit still writes via the same APIs (no behavior change).
6. Design/brand: Sand & Surf, one coral accent per view, no em-dashes, responsive, a11y (modal focus trap + Escape + aria, toast aria-live, palette keyboard nav, visible focus).

## Gotchas
- `node_modules` is a symlink to the Tex app's; present (Next 15.3.3).
- NEVER `npm run build` while `next dev` is live (shared `.next` corrupts): stop dev + `rm -rf .next` first.
- Tests need `--no-file-parallelism`.
- Co-located per-section CSS files (imported by the page) avoid concurrent edits to the shared `admin.css`; only the KIT owns shared component CSS.

---

## ADDENDUM (added mid-run, 2026-06-24) — Booking becomes a step-by-step animated wizard
**Scope note:** this is a FOLLOW-UP build AFTER the foundation workflow. The foundation workflow's booking work is a Sand & Surf restyle (all sections visible); that restyle + `public.css` are the visual base. Reviewers in the foundation workflow should NOT flag "booking is not a wizard" — the wizard is intentionally a separate next step. The wizard reuses the restyled per-step field markup and `public.css` classes.

**Target end-state for `/book`:** convert the single long form into a one-step-at-a-time wizard.
- **Steps** (keep all existing fields, handlers, and APIs exactly): 1 Car type, 2 Dates, 3 Insurance, 4 Extras, 5 Driver's licence, 6 Your details, 7 Review and confirm. (Review may be folded into the last step.)
- **One step visible at a time.** A **progress stepper** at the top shows all steps: current highlighted, completed steps get a check, upcoming steps muted; `aria-current` on the active step; completed steps are clickable to go back.
- **Navigation:** a "Continue" button advances and a "Back" button returns. Continue is gated by **per-step validation** (cannot leave step 1 without a class, step 2 needs a valid date range, step 5 needs the licence fields, step 6 needs name/email/phone, etc.). Final step submits via the SAME create-booking call.
- **Animated transitions:** direction-aware CSS slide (translateX) + fade between steps (forward slides one way, Back the other). CSP-safe (CSS only, no eval). `prefers-reduced-motion` = instant, no transform.
- **Summary sidebar** persists and updates as steps complete (running price). On mobile it collapses to a sticky bottom bar or shows on the review step.
- **A11y:** on step change, move focus to the new step heading and announce via `aria-live`; full keyboard support.
- **Preserve all booking logic** (quote / availability / create booking). Only presentation + navigation change. Tests stay green.
