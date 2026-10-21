# Flow Desk Phase 3 (Sheet, Fleet, Money, Setup) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the Flow desk language into the four remaining owner screens: the booking drawer becomes a sheet with a stage track and one coral "next stage" button, Fleet becomes car cards with one car sheet, Reports becomes Money with one huge number, Setup opens on a progress checklist, and five "are you sure?" dialogs become 6-second undo toasts.

**Architecture:** Presentation plus four small pure modules, each with tests: `booking-stage.ts` (which stage a booking is at and what the next action is), `fleet-card.ts` (compliance badges and rate line, lifted out of the fleet page), `money-headline.ts` (this month, last month, delta), `setup-progress.ts` (checklist items and percent). One new read route (`GET /api/admin/setup-progress`, owner only) feeds the checklist. Every existing API route, handler and money control keeps its behaviour; undo is "commit now, run the inverse call on Undo", so nothing is lost on navigation.

**Tech Stack:** Next.js 15 App Router, React 19, plain CSS with tokens from `src/app/tokens.css`, Vitest (node). Strict CSP (no CDN, CSS motion only).

**Spec:** `docs/superpowers/specs/2026-10-14-yabi-flow-desk-design.html`, chapter "Screen by screen" (sections Booking sheet, Fleet, Money, Setup) and chapter "Game, not work" (loop four, "Cheap undo"). Conventions: `docs/superpowers/plans/2026-10-15-flow-desk-phase-2-board.md`.

## Global Constraints

- Behaviour freeze on money: mark paid, other amount, paid until, change price, refund, cancel, extend, swap, move keep their routes, payloads, owner gating and copy rules exactly as on `feat/desk-money-controls`. Only placement, button class and section chrome change.
- Coral (`--signal`, `btn--accent`) means "tap this". In the booking sheet exactly one control is coral: the next-stage button. Inline sub-forms inside the sheet (price edit, other amount, move, swap) use plain `btn`. Modals opened from the sheet (refund, cancel, extend, swap advisory, repair) are their own surfaces and keep their one `btn--accent`.
- One coral per page elsewhere: Fleet "Add car", Money none (Export is quiet), Setup checklist "Do this next" link.
- Status is ink (`--amber`, `--teal`, `--pickup`, `--overdue`, `--ok`, `--danger`), never coral.
- Undo toast duration is exactly 6000 ms, label "Undo". Irreversible actions keep their confirm: cancel booking, regenerate staff code, board "Book anyway", block-car-from-note, delete availability block (its times are not returned by the list API).
- Premium, not cartoon: hairlines, tone-on-tone, soft shadows. No badges, points, confetti, emoji.
- Visible copy: no em-dashes, no "01 / 03" or "3 of 9" style step labels except the existing Today "N of M done" progress line, which the spec quotes.
- Strict CSP: `next/font` only, no CDN, no inline scripts; motion in CSS with a `prefers-reduced-motion` guard.
- Branch: `feat/flow-desk-phase-3` off `feat/flow-desk-board` (@d770f20). One implementer at a time in this checkout. Commit after every task with the attribution lines.
- Before every commit: `npm run typecheck && npm run lint && npm test`. Never `next build` while a dev server runs. Dev server: `APP_ORIGIN=http://localhost:3001 CORS_ALLOWED_ORIGINS=http://localhost:3001 npx next dev -p 3001`.

## Review Focus

1. A cancelled booking opens to a track that says Cancelled, with no coral button and no money actions offered. Pinned in Task 3 (`stageFor` cancelled case) and checked in Task 10.
2. A completed rental that still owes money sits at "Back" with "Take payment" as the coral button, and pressing it records exactly `balanceDueCents` through the existing desk-payment route. Pinned in Task 3 and Task 4.
3. Undo pressed twice, or after the page that raised it unmounted, runs the inverse call once and still works (the toast lives in the shell provider). Pinned in Task 2 (`once` test) and checked in Task 10.
4. Setup progress never counts an item done vacuously: zero active cars means "Cars and rates" and "Deposits" are open, not done. Pinned in Task 8.
5. Money with nothing last month says "Nothing booked last month" instead of a percent; January compares against December through `revenueByMonth` order, not calendar math. Pinned in Task 7.

---

### Task 0: Branch

- [ ] **Step 1:** `git status --short` shows only `.dev-db.broken-2026-09-09/`; then `git checkout -b feat/flow-desk-phase-3 feat/flow-desk-board`. Commit this plan file on the new branch: `git add docs/superpowers/plans/2026-10-21-flow-desk-phase-3-sheet-fleet-money-setup.md && git commit -m "docs: flow desk phase 3 plan"`.

---

### Task 1: Guard covers the Phase 3 stylesheets

**Files:**
- Modify: `src/test/coral-is-signal.test.ts`
- Modify: `src/app/admin/(shell)/fleet/fleet.css`, `src/app/admin/(shell)/reports/reports.css` (whatever the guard flags)

- [ ] **Step 1: Extend the guard.** Add `#f2563f` and `#ff7d68` (case-insensitive) to the coral body regex. Add to the scanned list: `admin/(shell)/booking-drawer.css`, `admin/(shell)/fleet/fleet.css`, `admin/(shell)/reports/reports.css`, `admin/(shell)/settings/settings.css`, `admin/(shell)/catalog/catalog.css`, `admin/(shell)/staff/staff.css`. Add to `ALLOWED` only selectors that are tap targets and that later tasks create: `.bd-next`, `.fc-add`, `.su-next`.
- [ ] **Step 2:** `npx vitest run src/test/coral-is-signal.test.ts` → FAIL listing the current coral selectors in fleet.css and reports.css.
- [ ] **Step 3:** Recolour each flagged rule to ink (`--teal-700` for selected filter chips, `--ink` for the reports accent KPI). Do not add them to the allow-list.
- [ ] **Step 4:** Same command → PASS. Full checks green.
- [ ] **Step 5:** Commit `test(guard): coral stays signal on fleet, money and setup sheets`.

---

### Task 2: Undo toasts

**Files:**
- Modify: `src/app/admin/_ui/Toast.tsx`, `src/app/admin/_ui/index.ts`, `src/app/admin/admin.css` (`.ui-toast__action`)
- Create: `src/app/admin/_ui/undo.ts`
- Modify: `src/app/admin/(shell)/fleet/page.tsx` (retire), `settings/page.tsx` (remove blackout), `staff/page.tsx` (deactivate), `catalog/page.tsx` (delete add-on, delete tier)
- Test: `src/test/undo-toast.test.ts`

**Interfaces:**
- Produces: `ToastOptions.action?: { label: string; onClick: () => void }` (clicking dismisses the toast, then calls `onClick`). `UNDO_MS = 6000`. `once(fn: () => void): () => void`. `undoToast(message: string, onUndo: () => void): ToastOptions` returning `{ type: "success", message, duration: UNDO_MS, action: { label: "Undo", onClick: once(onUndo) } }`. Hook `useUndo(): (message: string, revert: () => Promise<void>) => void`; on Undo it awaits `revert`, then shows `"Undone."` (success) or the `ApiError` message (error).

- [ ] **Step 1: Failing tests** in `src/test/undo-toast.test.ts`:

```ts
import { undoToast, once, UNDO_MS } from "@/app/admin/_ui/undo";
it("lasts six seconds and says Undo", () => {
  const t = undoToast("Car retired.", () => {});
  expect(UNDO_MS).toBe(6000);
  expect(t).toMatchObject({ type: "success", message: "Car retired.", duration: 6000, action: { label: "Undo" } });
});
it("runs the revert once however often Undo is pressed", () => {
  let n = 0; const t = undoToast("x", () => { n++; });
  t.action!.onClick(); t.action!.onClick();
  expect(n).toBe(1);
});
it("once passes through the first call only", () => { let n = 0; const f = once(() => n++); f(); f(); f(); expect(n).toBe(1); });
```

- [ ] **Step 2:** `npx vitest run src/test/undo-toast.test.ts` → FAIL, module not found.
- [ ] **Step 3:** Implement `undo.ts` (pure exports plus the `"use client"`-safe `useUndo` hook built on `useToast`); add `action` to `ToastItem`/`ToastOptions` and render it as `<button className="ui-toast__action">` before the close button. Style: quiet text button, `--teal-700`, weight 600. Export `useUndo`, `undoToast` from `_ui/index.ts`.
- [ ] **Step 4:** Replace the five confirms. Each commits immediately, reloads, then calls `undo(message, revert)`:
  - Fleet retire: message `"{plate} retired."`, revert `apiPatch(/api/admin/vehicles/{id}, { status: <previous status> })` then reload.
  - Settings remove blackout: `"Blackout removed."`, revert `api("/api/admin/blackouts", { startDate, endDate, reason })` then reload.
  - Staff deactivate: `"{name} deactivated."`, revert `apiPatch(/api/admin/staff/{id}, { active: true })` then reload. Reactivate stays a plain action.
  - Catalog delete add-on: `"Add-on deleted."`, revert re-creates it with the same `name, description, priceCents, pricing, category, stock, active`. Delete tier: `"Tier deleted."`, revert re-creates with `name, dailyPriceCents, coverage, isDefault, active`. Use the body shape the create forms in `catalog/page.tsx` already send.
  Remove `useConfirm` imports that become unused.
- [ ] **Step 5:** Tests PASS, full checks green. Commit `feat(desk): undo toasts replace five are-you-sure dialogs`.

---

### Task 3: Booking stage

**Files:**
- Create: `src/lib/admin/booking-stage.ts`
- Test: `src/test/booking-stage.test.ts`

**Interfaces:**
- Produces:

```ts
export type StageKey = "reserved" | "paid" | "out" | "back" | "closed";
export const STAGES: { key: StageKey; label: string }[]; // Reserved, Paid, Out, Back, Closed
export type NextAction =
  | { kind: "confirm"; label: "Confirm booking" }
  | { kind: "link"; label: "Start handover" | "Check in return"; href: string }
  | { kind: "pay"; label: "Take payment"; amountCents: number };
export interface StageView { cancelled: boolean; current: StageKey | null; next: NextAction | null }
export function stageFor(i: { id: string; status: string; balanceDueCents: number; paymentMode: "online" | "desk" }): StageView;
```

Rules: `pending` → reserved, next confirm only in desk mode (online: null, the webhook confirms). `confirmed` → paid, next link `Start handover` to `/admin/inspect/{id}/checkin`. `picked_up` → out, next link `Check in return` to `/admin/inspect/{id}/checkout`. `completed` with balance > 0 → back, next pay with `amountCents = balanceDueCents`. `completed` with balance ≤ 0 → closed, next null. `cancelled` → `{ cancelled: true, current: null, next: null }`. Unknown status → current null, next null. The hrefs match `src/lib/admin/today.ts`.

- [ ] **Step 1:** Tests, one `it` per rule above, asserting the exact `StageView` (including desk vs online pending, and completed at 0 and at 4500 cents).
- [ ] **Step 2:** `npx vitest run src/test/booking-stage.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS. Commit `feat(sheet): stageFor names the stage and the next step`.

---

### Task 4: Booking sheet

**Files:**
- Create: `src/app/admin/(shell)/stage-track.tsx`
- Modify: `src/app/admin/(shell)/booking-drawer.tsx`, `src/app/admin/(shell)/booking-drawer.css`

**Interfaces:**
- Consumes: `stageFor`, `STAGES`, `NextAction` (Task 3).
- Produces: `StageTrack({ view }: { view: StageView })`, an `<ol className="bd-track">` of five steps with `is-done` / `is-current`, `aria-current="step"` on the current one; cancelled renders one `bd-track--cancelled` line "Cancelled".

- [ ] **Step 1: Sheet head (three planes).** Top of the drawer body: plate huge and faint in the back (`.bd-head__plate`, `--fs-huge`, ink at low alpha), customer name and period in the middle, the next-stage button on top. The button is `.btn.btn--accent.bd-next`: `confirm` calls `doConfirm`, `link` is a `<Link>`, `pay` calls `recordPayment(next.amountCents)`. Below it, `StageTrack`.
- [ ] **Step 2: One coral.** Remove the old "Confirm booking" from Actions (the head owns it). "Mark as paid (…)" becomes `btn` unless the stage's next is `pay`, in which case that group hides its own button (the head already offers it) and keeps "Other amount…". Inline Save price, Record payment, Save move, Swap car become `btn`. Modal buttons unchanged.
- [ ] **Step 3: Quiet pills.** Actions row (Move, Extend, Swap car, Cancel rental) renders as `.bd-pills` quiet pills; Cancel keeps `danger`. Section `<h3>`s become tiny uppercase labels (`--fs-tiny`). Paid-until hint copy loses its em-dash: "Leave this empty for ordinary rentals. Then the balance above decides."
- [ ] **Step 4: Track styles** in `booking-drawer.css`: hairline connector, done steps `--ok` ink, current step `--teal-700` with a 2px rail, no coral. Reduced-motion guard on the current-step fade.
- [ ] **Step 5:** Full checks green (coral guard now scans this file). Dev server: open a pending (desk), confirmed, picked-up, completed-unpaid, cancelled booking from the board; each shows the expected head button and track. Commit `feat(sheet): booking drawer becomes a sheet with a stage track`.

---

### Task 5: Fleet card helpers

**Files:**
- Create: `src/lib/admin/fleet-card.ts`
- Test: `src/test/fleet-card.test.ts`

**Interfaces:**
- Produces: `complianceBadges(v: { insuranceExpiresOn: string | null; inspectionDueOn: string | null }, today: string, alertDays: number): { key: "Insurance" | "Inspection"; label: string; overdue: boolean }[]` (same labels as today's fleet page: `"Insurance 12d"`, `"Inspection overdue"`; hidden beyond `alertDays`). `rateLine(v: { priceDayCents: number; priceWeekCents: number; priceMonthCents: number }, sym: string): string` → `"$45 day · $280 week · $990 month"`. `sortForCards<T extends { status: string; class: string; plate: string }>(vs: T[], classOrder: string[]): T[]` (retired last, then class order, then plate).

- [ ] **Step 1:** Tests: badge at exactly `alertDays` shows, at `alertDays + 1` hides, negative is overdue, null dates give none; rate line format; retired sorts after active of an earlier class.
- [ ] **Step 2:** FAIL. **Step 3:** Implement, then make `fleet/page.tsx` import `complianceBadges` instead of its inline copy. **Step 4:** PASS, full checks green. Commit `refactor(fleet): card helpers move to a tested module`.

---

### Task 6: Fleet as cards, one car sheet

**Files:**
- Create: `src/app/admin/(shell)/fleet/car-card.tsx`, `src/app/admin/(shell)/fleet/car-sheet.tsx`
- Modify: `src/app/admin/(shell)/fleet/page.tsx`, `fleet.css`

**Interfaces:**
- Consumes: Task 5 helpers, `useUndo` (Task 2).
- Produces: `CarCard({ v, today, alertDays, onOpen, onEditRates })`; `CarSheet({ vehicle, onClose, onChanged, onEditRates })` holding Notes, Blocks and Retire.

- [ ] **Step 1: Card (three planes).** Photo (`v.photos[0]`) as a soft background when present, otherwise a tone-on-tone panel; plate huge in the back; name, class and `rateLine` in the middle; compliance badges and an open-notes count as ink chips; "Edit rates" quiet button on top (opens the existing edit modal). The whole card is a button that opens `CarSheet`. Retired cards are muted and carry a "Retired" chip. Grid: `repeat(auto-fill, minmax(240px, 1fr))`, one column under 480px.
- [ ] **Step 2: Car sheet.** One `Drawer` replacing the separate Notes and Blocks drawers: sections Notes (same add / resolve / reopen / block-car flows), Blocks (same list, add form, delete with confirm), and a footer with "Edit car" and "Retire car" (`danger`, undo from Task 2) or "Reactivate" for retired cars (PATCH status active). Move the notes and blocks state and handlers out of `page.tsx` into `car-sheet.tsx`.
- [ ] **Step 3: Page head.** `<h1>Fleet</h1>` with one tiny line "{n} cars". Search and class chips stay. "Add vehicle" becomes "Add car" with `.btn.btn--accent.fc-add`. Remove the table, the skeleton table and `SPAN_ALL`; loading shows six card skeletons.
- [ ] **Step 4:** Full checks green. Dev server at 375px and 1280px: cards wrap, a car without photos looks finished, search and class filter work, retire then Undo restores the car. Commit `feat(fleet): cars become cards with one car sheet`.

---

### Task 7: Money

**Files:**
- Create: `src/lib/admin/money-headline.ts`
- Modify: `src/app/admin/(shell)/reports/page.tsx`, `reports.css`
- Test: `src/test/money-headline.test.ts`

**Interfaces:**
- Produces: `moneyHeadline(revenueByMonth: { month: string; cents: number }[], monthKey: string): { thisMonthCents: number; lastMonthCents: number | null; deltaPct: number | null; line: string }`. This month = the entry whose `month === monthKey` (0 if absent); last month = the entry before it in array order (null if none). `deltaPct = round((this - last) / last * 100)` when last > 0, else null. `line`: `"Up 12% on last month"`, `"Down 8% on last month"`, `"Level with last month"` (0%), or `"Nothing booked last month"` when last is null or 0. Formatting of the amount stays in the page.

- [ ] **Step 1:** Tests for up, down, level, last month zero, no previous entry, and `monthKey "2026-01"` with `"2025-12"` before it.
- [ ] **Step 2:** FAIL. **Step 3:** Implement.
- [ ] **Step 4: Page.** `<h1>Money</h1>`. Hero: the month revenue huge (`--fs-huge`), `line` tiny under it. Remove the six-KPI grid; keep "Out on rental now" and "Fleet booked, next 30 days" as two tiny ink stats under the line. "Revenue per car" becomes horizontal bars of each car's year total (`perCar.rows`, sorted desc, reusing `.rp-hbar`), with the full month matrix inside `<details><summary>Month by month</summary>…</details>`. "Deposits held" becomes its own card (Held, Returned, Withheld, plus the withheld list and the "not income" line), renamed from "Borg" in the heading only. One quiet `<details className="rp-export">` menu labelled "Export" holds the year and month selects, "Month PDF" and "Year PDF" links. Revenue by month and by class panels stay below; "Top earning cars" goes (the per-car bars replace it). Palette action ids and labels unchanged; side-nav label already says Money.
- [ ] **Step 5:** PASS, full checks green, page renders in the dev server with the seeded demo data. Commit `feat(money): one huge number, per-car bars, deposits card, one export menu`.

---

### Task 8: Setup progress (logic and route)

**Files:**
- Create: `src/lib/admin/setup-progress.ts`, `src/lib/admin/setup-progress-loader.ts`, `src/app/api/admin/setup-progress/route.ts`
- Test: `src/test/setup-progress.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SetupInput {
  alertRecipients: number; activeCars: number; carsWithDayRate: number; carsWithDeposit: number;
  activeTiers: number; activeAddOns: number; policiesPublished: number; // of 3 types
  paymentsReady: boolean; activeStaff: number; liveBookings: number;   // non-cancelled
}
export interface SetupItem { key: string; label: string; hint: string; href: string | null; done: boolean }
export interface SetupProgress { items: SetupItem[]; done: number; total: number; pct: number; next: SetupItem | null }
export function setupProgress(i: SetupInput): SetupProgress;
```

Items in this order (label, done rule, href):
`hours` "Opening hours and booking alerts", `alertRecipients > 0`, `/admin/settings`;
`rates` "Cars and rates", `activeCars > 0 && carsWithDayRate === activeCars`, `/admin/fleet`;
`deposits` "Deposits", `activeCars > 0 && carsWithDeposit === activeCars`, `/admin/fleet`;
`insurance` "Insurance tiers", `activeTiers > 0`, `/admin/catalog`;
`addons` "Add-ons", `activeAddOns > 0`, `/admin/catalog`;
`policies` "Policies", `policiesPublished === 3`, `/admin/policies`;
`payments` "Payments", `paymentsReady`, `null` (hint "Switched on with your account.");
`team` "Your team", `activeStaff > 0`, `/admin/staff`;
`first` "First booking", `liveBookings > 0`, `/admin/board`.
`pct = round(done / total * 100)`; `next` = first item not done. Each hint is one short sentence naming what to do.

Loader `getSetupProgress(): Promise<SetupProgress>` counts from `getSettings`, `listVehicles` (status ≠ retired), `listInsurance`, `listAddOns`, `policyOverview`, `listStaff`, a count of bookings with status ≠ cancelled, and `paymentsReady = env.PAYMENT_MODE === "desk" || Boolean(env.STRIPE_SECRET_KEY)`. Route: `GET`, `read(req, () => getSetupProgress())` with the default owner-only role, same shape as `src/app/api/admin/reports/route.ts`.

- [ ] **Step 1:** Tests: all zero gives 1 done (payments) of 9 and `next.key === "hours"`; zero active cars leaves rates and deposits open even with zero counts; 2 cars with 1 deposit leaves deposits open; everything set gives 100 and `next === null`; pct for 6 of 9 is 67.
- [ ] **Step 2:** FAIL. **Step 3:** Implement module, loader, route.
- [ ] **Step 4:** PASS, full checks green; `curl` the route on the dev server with an owner session cookie returns the shape (or check in the browser network tab). Commit `feat(setup): setup progress checklist logic and route`.

---

### Task 9: Setup checklist and the Today hook

**Files:**
- Create: `src/app/admin/(shell)/setup-checklist.tsx`, `src/app/admin/(shell)/setup-checklist.css`
- Modify: `src/app/admin/(shell)/settings/page.tsx`, `catalog/page.tsx`, `policies/page.tsx`, `staff/page.tsx`, `audit/page.tsx` (render it under `SetupNav`), `src/app/admin/(shell)/page.tsx` (Today hook)

**Interfaces:**
- Consumes: `GET /api/admin/setup-progress` → `SetupProgress` (Task 8).
- Produces: `SetupChecklist()` (fetches on mount; renders nothing on error) and `SetupHook()` for Today.

- [ ] **Step 1: Checklist.** Head: "Your desk is {pct}% ready" with a thin progress bar (same visual as `.td-progress`). Items as a list: done items show a check in `--ok` ink and fade; open items show label and hint; the `next` item expands by default and carries the one coral link `.su-next` "Do this next" to its href (no link when href is null). Clicking any open item toggles its hint inline. At 100% the whole block collapses to one tiny line "Your desk is ready." Add `setup-checklist.css` to the coral guard list.
- [ ] **Step 2: Placement.** Render `<SetupChecklist />` directly under `<SetupNav />` on all five Setup pages.
- [ ] **Step 3: Today hook.** For owners only and only when `pct < 100`: one tiny line under the progress bar on Today, "Your desk is {pct}% ready. Next: {next.label}." with the label as a quiet link to `next.href`. Staff never fetch it (the route is owner-only).
- [ ] **Step 4:** Full checks green. Dev server: a fresh-ish local DB shows the checklist with the right next item; adding an alert email in Settings and reloading moves the bar. Commit `feat(setup): your desk is N% ready, on Setup and Today`.

---

### Task 10: Pass and close

- [ ] **Step 1:** `npm run typecheck && npm run lint && npm test` green; stop the dev server, `npm run build` green.
- [ ] **Step 2:** Dev server at 375px and 1280px, owner and staff logins: Today, Board, the sheet from five booking states (Review Focus 1, 2), Fleet cards and car sheet, Money, every Setup tab. Retire then Undo; deactivate staff then Undo after navigating to another page (Review Focus 3). Staff see Today, Board, Fleet only and no setup hook.
- [ ] **Step 3:** Grep visible copy added in this phase for `—` and `--` in JSX text: none.
- [ ] **Step 4:** Whole-branch review (superpowers:requesting-code-review). Fix wave if needed, then update the memory note `project_yabi_flow_desk_redesign.md` with the branch head and parked items.
