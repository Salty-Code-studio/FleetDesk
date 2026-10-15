# Flow Desk Phase 2 (Board) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the planning board to the Flow desk language without touching its drag, zoom or booking logic: three-plane bars (plate behind, customer in front, status as a tiny chip), the stat strip and instruction paragraph gone, a first-use hint shown once, a tokenised legend, a smooth zoom into the day view, and coral removed from every status use in the shell.

**Architecture:** Presentation only. The board page (`src/app/admin/(shell)/board/page.tsx`) keeps every handler, state and API call; only JSX inside the two bar renders, the page head and the legend change, plus CSS. One new pure module (`src/lib/admin/bar-chip.ts`) decides the chip label and tone for a bar state, with tests. A hint flag lives in `localStorage` and is read in a `useEffect` so server render stays stable.

**Tech Stack:** Next.js 15 App Router, React 19, plain CSS with tokens from `src/app/tokens.css`, Vitest (node). Strict CSP (no CDN, CSS motion only).

**Spec:** `docs/superpowers/specs/2026-10-14-yabi-flow-desk-design.html`, chapter "Screen by screen", section "Board (restyle, logic untouched)", plus the three rules in "What the reel actually says". Phase 1 plan for conventions: `docs/superpowers/plans/2026-10-14-flow-desk-phase-1.md`.

## Global Constraints

- Behaviour freeze on the board: no change to `barSpan`, `barState`, `hourSpan`, the drag guard, pointer handlers, popovers, `ServiceModal`, `BookingDrawer`, API calls or the `title` tooltips. The logic tests `src/test/planning-bars.test.ts`, `drag-click-guard.test.ts`, `hour-grid.test.ts`, `admin-planning.test.ts` must stay green untouched.
- Coral (`--signal`) means "tap this" and nothing else. After this phase no status, highlight or badge in `admin.css` or `board/dashboard.css` uses coral; the notification bell badge (a tap target with a count) is the one allowed exception.
- One coral control per view: on the board it is "Schedule service". The create-rental popover's "Add rental" / "Block car" and the service modal's "Schedule" keep `btn--accent` because each is its own surface.
- Status colours stay the existing ink set (`--amber`, `--teal`, `--pickup`, `--overdue`, `--ok`, `--danger`); the restyle changes where they are applied (rail and chip), not what they are.
- Premium, not cartoon: hairlines, tone-on-tone tints, soft shadows. No emoji except the existing `✦` manual marker, which becomes a mono glyph in the chip.
- Visible copy: no em-dashes, no "01 / 03" style labels.
- Strict CSP: fonts via `next/font` only, no CDN, no inline scripts; motion in CSS with a `prefers-reduced-motion` guard.
- Branch: `feat/flow-desk-board` off `feat/flow-desk` (@7a757ac). Commit after every task with the two attribution lines (model name may be the implementer's own).
- Run `npm run typecheck && npm run lint && npm test` before every commit; never run `next build` while a dev server is up (it clobbers `.next`); the local dev server runs on port 3001 with `APP_ORIGIN=http://localhost:3001 CORS_ALLOWED_ORIGINS=http://localhost:3001 npx next dev -p 3001` (port 3000 belongs to another project).
- Carry-over from Phase 1 (parked): the ≤640px Today rule must also place `.td-row__owner` in column 2.

## Review Focus

1. A bar narrower than about 60px (one day at 14-day zoom, or a few hours in day zoom) must stay readable: the plate plane and the chip must hide, the customer name must ellipsise, and the status rail must still show the colour. Pinned by CSS container rules in Task 5 and checked in Task 7.
2. An unpaid bar must read as unpaid at a glance in both renders: the rail turns `--danger` and the chip says "unpaid", replacing the old diagonal stripes. Pinned by `chipFor` tests in Task 2.
3. A dragged bar must still look dragged (`.dragging` dims) and a moved ghost must still render; the restyle must not break `.pl-ghost` / `.pl-select`. Checked in Task 7 Step 3.
4. The first-use hint must appear once per browser, never on the server render (no hydration mismatch), and never again after dismiss. Pinned by the `useEffect` pattern in Task 3 and checked in Task 7.
5. The zoom animation must not run for users who prefer reduced motion and must not delay the click handlers (animation on opacity/transform only). Pinned by the CSS in Task 6.

---

### Task 0: Branch

- [ ] **Step 1: Branch off the Phase 1 head**

```bash
cd ~/Desktop/SaltyCode/04-Products/saltycodestudio-products/fleetdesk
git status --short
git checkout -b feat/flow-desk-board feat/flow-desk
git branch --show-current
```
Expected: only `.dev-db.broken-2026-09-09/` untracked; last line `feat/flow-desk-board`. This plan is already committed on `feat/flow-desk`, so nothing else to do here.

---

### Task 1: Coral is not a status (CSS housekeeping)

**Files:**
- Modify: `src/app/admin/admin.css` (`.pl-day.today`, `.pl-day.today .dnum`, `.pl-cells .c.today`, `.pl-msg`, `.nbell__item.is-unread`)
- Modify: `src/app/admin/(shell)/board/dashboard.css:60-63` (focus outline uses `--coral`)
- Modify: `src/app/admin/(shell)/today.css` (≤640px rule gains `.td-row__owner`)
- Test: `src/test/coral-is-signal.test.ts`

- [ ] **Step 1: Write the failing guard test**

```ts
// src/test/coral-is-signal.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const app = path.resolve(__dirname, "../app");
const read = (p: string) => readFileSync(path.join(app, p), "utf8");

/** Rules allowed to use coral: tap targets. Everything else is ink. */
const ALLOWED = [
  ".btn--accent", ".btn-demo", ".td-row__do", ".td-cta", ":focus-visible", ".nbell__badge",
  ".ui-palette__icon", ".auth-brand::before", ".logo-mark", ".td-row__who:focus-visible",
];

function coralRules(css: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const [, sel, body] = m;
    if (/var\(--(coral|signal)[^)]*\)|rgba\(255,\s*111,\s*89/i.test(body!)) out.push(sel!.trim());
  }
  return out;
}

describe("coral is the signal colour, never a status", () => {
  for (const file of ["admin/admin.css", "admin/(shell)/board/dashboard.css", "admin/(shell)/today.css"]) {
    it(`${file} uses coral only on tap targets`, () => {
      const offenders = coralRules(read(file)).filter((sel) => !ALLOWED.some((a) => sel.includes(a)));
      expect(offenders).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Run it to see the offenders**

Run: `npx vitest run src/test/coral-is-signal.test.ts`
Expected: FAIL listing `.pl-day.today`, `.pl-day.today .dnum`, `.pl-cells .c.today`, `.pl-msg`, `.nbell__item.is-unread`, the dashboard focus rule, and `.btn-demo` shadow (allowed) is not listed. If a selector you did not expect appears, read it and decide: tap target (add to `ALLOWED` with a comment) or status (fix it).

- [ ] **Step 3: Fix the status uses in admin.css**

```css
.pl-day.today { background: rgba(14,58,64,.08); }
.pl-day.today .dnum { color: var(--teal); }
.pl-cells .c.today { background: rgba(14,58,64,.05); }
.pl-msg { color: var(--danger); font-size: .8rem; font-weight: 600; }
.nbell__item.is-unread { background: rgba(79,168,201,.08); }
```
(The today column goes from a coral wash to a teal wash; unread notifications go from coral to sky.)

- [ ] **Step 4: Fix the dashboard focus rule and the Today mobile rule**

In `board/dashboard.css` replace the focus block's `outline: 2px solid var(--coral); outline-offset: 1px; border-color: var(--coral);` with `outline: 2px solid var(--teal); outline-offset: 1px; border-color: var(--teal);` (date inputs are form fields, not signals; the global `:focus-visible` ring remains coral).

In `today.css`, the `@media (max-width: 640px)` rule: change `.td-row__do, .td-row__done { grid-column: 2; justify-self: start; }` to `.td-row__do, .td-row__done, .td-row__owner { grid-column: 2; justify-self: start; }`.

- [ ] **Step 5: Run the guard, the pinned tests, lint**

Run: `npx vitest run src/test/coral-is-signal.test.ts src/test/confirm-dialog.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/admin/admin.css "src/app/admin/(shell)/board/dashboard.css" "src/app/admin/(shell)/today.css" src/test/coral-is-signal.test.ts
git commit -m "style(admin): coral never marks a status; today column and unread rows go ink

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HVdmWTpmwzjKnKXtyjbsor"
```

---

### Task 2: Bar chip helper (pure)

**Files:**
- Create: `src/lib/admin/bar-chip.ts`
- Test: `src/test/bar-chip.test.ts`

**Interfaces:**
- Consumes: `BarState` from `@/lib/admin/bar-span`.
- Produces:
```ts
export type ChipTone = "pending" | "confirmed" | "out" | "due" | "late" | "done" | "unpaid";
export interface BarChip { label: string; tone: ChipTone }
export function chipFor(state: BarState, unpaid: boolean, manual: boolean): BarChip
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/test/bar-chip.test.ts
import { describe, it, expect } from "vitest";
import { chipFor } from "@/lib/admin/bar-chip";

describe("chipFor", () => {
  it("maps each bar state to a short label and a tone", () => {
    expect(chipFor("pending", false, false)).toEqual({ label: "pending", tone: "pending" });
    expect(chipFor("confirmed", false, false)).toEqual({ label: "booked", tone: "confirmed" });
    expect(chipFor("picked_up", false, false)).toEqual({ label: "out", tone: "out" });
    expect(chipFor("due_back_soon", false, false)).toEqual({ label: "due", tone: "due" });
    expect(chipFor("overdue", false, false)).toEqual({ label: "late", tone: "late" });
    expect(chipFor("completed", false, false)).toEqual({ label: "back", tone: "done" });
  });
  it("unpaid wins over any state that can owe money", () => {
    expect(chipFor("picked_up", true, false)).toEqual({ label: "unpaid", tone: "unpaid" });
    expect(chipFor("completed", true, false)).toEqual({ label: "unpaid", tone: "unpaid" });
    expect(chipFor("overdue", true, false)).toEqual({ label: "unpaid", tone: "unpaid" });
  });
  it("a manual booking keeps its state but the label says desk", () => {
    expect(chipFor("confirmed", false, true)).toEqual({ label: "booked ✦", tone: "confirmed" });
  });
  it("cancelled never reaches the board but still maps safely", () => {
    expect(chipFor("cancelled", false, false)).toEqual({ label: "cancelled", tone: "done" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/test/bar-chip.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/admin/bar-chip.ts
/**
 * The tiny status chip on a planning bar. Pure: the board decides nothing
 * about colour, it only asks "what chip does this bar wear?". Tones map to
 * CSS classes .pl-bar--tone-<tone>; see board/dashboard.css.
 */
import type { BarState } from "@/lib/admin/bar-span";

export type ChipTone = "pending" | "confirmed" | "out" | "due" | "late" | "done" | "unpaid";
export interface BarChip { label: string; tone: ChipTone }

const BY_STATE: Record<BarState, BarChip> = {
  pending: { label: "pending", tone: "pending" },
  confirmed: { label: "booked", tone: "confirmed" },
  picked_up: { label: "out", tone: "out" },
  due_back_soon: { label: "due", tone: "due" },
  overdue: { label: "late", tone: "late" },
  completed: { label: "back", tone: "done" },
  cancelled: { label: "cancelled", tone: "done" },
};

export function chipFor(state: BarState, unpaid: boolean, manual: boolean): BarChip {
  if (unpaid) return { label: "unpaid", tone: "unpaid" };
  const base = BY_STATE[state];
  return manual ? { ...base, label: `${base.label} ✦` } : base;
}
```

- [ ] **Step 4: Run, typecheck, commit**

Run: `npx vitest run src/test/bar-chip.test.ts && npm run typecheck`
```bash
git add src/lib/admin/bar-chip.ts src/test/bar-chip.test.ts
git commit -m "feat(board): chipFor maps a bar state to its tiny status chip

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HVdmWTpmwzjKnKXtyjbsor"
```

---

### Task 3: Board head: stat strip out, hint once

**Files:**
- Modify: `src/app/admin/(shell)/board/page.tsx` (the `stats` memo around line 280, the `<header>` and `.stat-strip` block around lines 293-306)
- Modify: `src/app/admin/(shell)/board/dashboard.css` (new `.pl-hint` rules)

- [ ] **Step 1: Remove the stats memo and the strip**

Delete the whole `const stats = useMemo(() => { ... }, [data]);` block. Delete the `<div className="stat-strip">…</div>` block (the four `.s` children). If `useMemo` is now unused in the file, keep the import only if another `useMemo` call remains (`flatVehicles` uses it, so it stays).

- [ ] **Step 2: Replace the instruction paragraph with a dismissible hint**

Add state and effect near the other `useState` calls:
```tsx
  // First-use hint: read in an effect so the server render never depends on
  // localStorage (no hydration mismatch). Dismissed once per browser.
  const [showHint, setShowHint] = useState(false);
  useEffect(() => {
    try { if (!localStorage.getItem("yabi.board.hint.v1")) setShowHint(true); } catch { /* storage unavailable: no hint */ }
  }, []);
  function dismissHint() {
    setShowHint(false);
    try { localStorage.setItem("yabi.board.hint.v1", "1"); } catch { /* ignore */ }
  }
```
Replace the header block with:
```tsx
      <header className="pl-page-head">
        <div className="pl-page-head__lead">
          <h1>Board</h1>
        </div>
        <button type="button" className="btn btn--accent pl-head-action" onClick={() => setShowService(true)}>Schedule service</button>
      </header>

      {showHint && (
        <div className="pl-hint" role="note">
          <span>Drag an empty stretch to add a rental or block. Drag a booking to move it. Click a day to zoom into its hours.</span>
          <button type="button" className="btn btn--quiet" onClick={dismissHint}>Got it</button>
        </div>
      )}
```

- [ ] **Step 3: Hint styles**

Append to `board/dashboard.css`:
```css
/* First-use hint. Shown once per browser, then never again. */
.pl-hint {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap;
  margin: 0 0 1rem; padding: .7rem .9rem;
  background: var(--fill); border: 1px solid var(--line); border-radius: var(--radius);
  font-size: var(--fs-small); color: var(--ink-soft);
}
.pl-hint .btn--quiet { width: auto; }
```

- [ ] **Step 4: Gates and commit**

Run: `npm run typecheck && npm run lint && npm test`
```bash
git add "src/app/admin/(shell)/board/page.tsx" "src/app/admin/(shell)/board/dashboard.css"
git commit -m "feat(board): drop the stat strip, show the how-to hint once

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HVdmWTpmwzjKnKXtyjbsor"
```

---

### Task 4: Legend on tokens

**Files:**
- Modify: `src/app/admin/(shell)/board/page.tsx` (the `.pl-legend` block, around lines 336-345)
- Modify: `src/app/admin/admin.css` (`.pl-legend`, `.pl-swatch`)

- [ ] **Step 1: Replace the inline-hex legend**

```tsx
        <div className="pl-legend" aria-label="Legend">
          <span><i className="pl-swatch pl-swatch--pending" /> pending</span>
          <span><i className="pl-swatch pl-swatch--confirmed" /> booked</span>
          <span><i className="pl-swatch pl-swatch--out" /> out</span>
          <span><i className="pl-swatch pl-swatch--due" /> due back</span>
          <span><i className="pl-swatch pl-swatch--late" /> late</span>
          <span><i className="pl-swatch pl-swatch--unpaid" /> unpaid</span>
          <span><i className="pl-swatch pl-swatch--done" /> back</span>
          <span><i className="pl-swatch pl-swatch--blocked" /> blocked</span>
        </div>
```

- [ ] **Step 2: Swatch classes in admin.css**

Replace `.pl-swatch { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }` with:
```css
.pl-legend { display: flex; gap: .35rem .8rem; margin-left: auto; font-size: var(--fs-tiny); font-family: var(--font-mono); letter-spacing: .04em; color: var(--ink-mute); align-items: center; flex-wrap: wrap; }
.pl-swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.pl-swatch--pending { background: var(--amber); }
.pl-swatch--confirmed { background: var(--teal); }
.pl-swatch--out { background: var(--pickup); }
.pl-swatch--due { background: var(--pickup); box-shadow: inset 0 0 0 2px var(--amber); }
.pl-swatch--late { background: var(--overdue); }
.pl-swatch--unpaid { background: var(--danger); }
.pl-swatch--done { background: var(--ok); }
.pl-swatch--blocked { background: var(--sand-2); border: 1px solid var(--line); }
```
(Delete the old `.pl-legend` rule so only this one remains.)

- [ ] **Step 3: Guard: no hex in the board page**

Run: `grep -n "#[0-9A-Fa-f]\{6\}" "src/app/admin/(shell)/board/page.tsx"`
Expected: no output.

- [ ] **Step 4: Gates and commit**

Run: `npm run typecheck && npm run lint && npx vitest run src/test/coral-is-signal.test.ts`
```bash
git add "src/app/admin/(shell)/board/page.tsx" src/app/admin/admin.css
git commit -m "style(board): legend reads from tokens, no inline hexes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HVdmWTpmwzjKnKXtyjbsor"
```

---

### Task 5: Three-plane bars

The bar becomes a small card: a status rail on the left (full status colour), a tone-on-tone tint, the plate as a faint back plane, the customer name in front, and a tiny chip at the right. Solid-fill bars and the diagonal unpaid stripes go. Both renders (multi-day and day zoom) change the same way.

**Files:**
- Modify: `src/app/admin/(shell)/board/page.tsx` (both `pl-bar` renders, around lines 414 and 479; add the `chipFor` import)
- Modify: `src/app/admin/admin.css` (the `.pl-bar*` block)

**Interfaces:**
- Consumes: `chipFor(state, unpaid, manual)` from Task 2.

- [ ] **Step 1: Import**

Add to the imports in `board/page.tsx`: `import { chipFor } from "@/lib/admin/bar-chip";`

- [ ] **Step 2: Multi-day bar markup**

Replace the bar `<div>` in the main render (the one with `onPointerDown`) by:
```tsx
                        return s ? (() => {
                          const state = barState(b, nowIso);
                          const chip = chipFor(state, Boolean(b.unpaid), b.source === "manual");
                          return (
                            <div key={b.id} className={`pl-bar pl-bar--tone-${chip.tone} ${dimmed ? "dragging" : ""}`} style={{ left: `${s.left}%`, width: `${s.width}%` }}
                              title={`${b.label} · ${formatTime(b.startAt)} to ${formatTime(b.endAt)} · ${b.status}${b.paidNote ? ` · ${b.paidNote}` : ""}${b.source === "manual" ? " · manual" : ""}`}
                              onPointerDown={(e) => onBarPointerDown(e, v, b)}
                              onClick={() => { if (dragClickGuard.consumeSuppressed()) return; setDrawerBookingId(b.id); }}>
                              <span className="pl-bar__back" aria-hidden="true">{v.plate}</span>
                              <span className="pl-bar__name">{b.label}</span>
                              <span className="pl-bar__chip">{chip.label}</span>
                            </div>
                          );
                        })() : null;
```
The `title`, `onPointerDown` and `onClick` lines are copied unchanged from the current code; only the className and the children change.

- [ ] **Step 3: Day-zoom bar markup**

Replace the zoom bar `<div>` (the one with `pl-bar--zoom`) by:
```tsx
                          return (() => {
                            const state = barState(b, nowIso);
                            const chip = chipFor(state, Boolean(b.unpaid), b.source === "manual");
                            return (
                              <div key={b.id} className={`pl-bar pl-bar--zoom pl-bar--tone-${chip.tone}`} style={{ left: `${s.left}%`, width: `${s.width}%` }}
                                title={`${b.label} · ${formatTime(b.startAt)} to ${formatTime(b.endAt)} · ${b.status}${b.paidNote ? ` · ${b.paidNote}` : ""}`}
                                onClick={() => setDrawerBookingId(b.id)}>
                                <span className="pl-bar__back" aria-hidden="true">{v.plate}</span>
                                <span className="pl-bar__name">{s.cutStart ? "‹ " : `${formatTime(b.startAt)} · `}{b.label}{s.cutEnd ? " ›" : ` · ${formatTime(b.endAt)}`}</span>
                                <span className="pl-bar__chip">{chip.label}</span>
                              </div>
                            );
                          })();
```

- [ ] **Step 4: Bar styles**

In `admin.css` replace everything from `.pl-bar {` through `.pl-bar.dragging { opacity: .35; }` with:
```css
/* Planning bar: a small three-plane card. Rail = status colour (left edge),
   tint = the same colour at low alpha, back plane = plate, front = customer,
   chip = tiny status word. Tones come from chipFor() in bar-chip.ts. */
.pl-bar {
  --tone: var(--teal);
  position: absolute; top: 6px; height: 34px; border-radius: 9px;
  display: flex; align-items: center; gap: .4rem; padding: 0 .5rem 0 .6rem;
  background: color-mix(in srgb, var(--tone) 12%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--tone) 28%, var(--line));
  box-shadow: inset 4px 0 0 var(--tone), var(--shadow-sm);
  color: var(--teal); font-family: var(--font-body); font-size: .78rem; font-weight: 600;
  overflow: hidden; white-space: nowrap; cursor: grab; touch-action: none; user-select: none;
  container-type: inline-size;
  transition: box-shadow var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
}
.pl-bar:hover { transform: translateY(-1px); box-shadow: inset 4px 0 0 var(--tone), var(--shadow-md); }
.pl-bar:active { cursor: grabbing; }
.pl-bar__back { position: absolute; right: .3rem; bottom: -.35rem; font-family: var(--font-mono); font-weight: 700; font-size: 1.5rem; letter-spacing: -.04em; color: var(--tone); opacity: .10; pointer-events: none; }
.pl-bar__name { position: relative; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.pl-bar__chip { position: relative; flex: 0 0 auto; font-family: var(--font-mono); font-size: .58rem; letter-spacing: .06em; text-transform: uppercase; padding: .1rem .38rem; border-radius: 999px; color: var(--panel); background: var(--tone); }
/* narrow bars: drop the planes, keep the rail and the name */
@container (max-width: 90px) { .pl-bar__chip, .pl-bar__back { display: none; } }
@container (max-width: 40px) { .pl-bar__name { display: none; } }
.pl-bar--tone-pending { --tone: var(--amber); }
.pl-bar--tone-confirmed { --tone: var(--teal); }
.pl-bar--tone-out { --tone: var(--pickup); cursor: default; }
.pl-bar--tone-due { --tone: var(--pickup); cursor: default; }
.pl-bar--tone-due .pl-bar__chip { background: var(--amber); color: var(--teal-700); }
.pl-bar--tone-late { --tone: var(--overdue); cursor: default; }
.pl-bar--tone-done { --tone: var(--ok); cursor: default; }
.pl-bar--tone-unpaid { --tone: var(--danger); }
.pl-bar.dragging { opacity: .35; }
```
Also bump the track so the taller bar fits: `.pl-track { position: relative; height: 46px; ... }` stays 46px (34 + 6 + 6). Delete the old `.pl-bar--pending … .pl-bar--unpaid` and `.pl-bar.manual::after` rules (the chip carries `✦` now).

- [ ] **Step 5: Gates**

Run: `npm run typecheck && npm run lint && npm test && npx vitest run src/test/coral-is-signal.test.ts`
Expected: green. `grep -n "pl-bar--pending\|pl-bar--unpaid\|pl-bar--picked_up" src/app/admin/admin.css "src/app/admin/(shell)/board/page.tsx"` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add "src/app/admin/(shell)/board/page.tsx" src/app/admin/admin.css
git commit -m "feat(board): three-plane bars with a status rail and a tiny chip

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HVdmWTpmwzjKnKXtyjbsor"
```

---

### Task 6: Smooth zoom

**Files:**
- Modify: `src/app/admin/(shell)/board/dashboard.css` (day-zoom block)

- [ ] **Step 1: Animate the zoom view on mount**

Append to `board/dashboard.css`:
```css
/* Zoom into a day: the hour grid settles in rather than cutting. Opacity and
   transform only, so handlers are live from the first frame. */
@keyframes pl-zoom-in { from { opacity: 0; transform: scale(.985) translateY(4px); } to { opacity: 1; transform: none; } }
.pl--hours, .pl-zoombar { animation: pl-zoom-in .22s var(--ease) both; }
@media (prefers-reduced-motion: reduce) { .pl--hours, .pl-zoombar { animation: none; } }
```

- [ ] **Step 2: Commit**

```bash
git add "src/app/admin/(shell)/board/dashboard.css"
git commit -m "style(board): the day zoom settles in instead of cutting

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HVdmWTpmwzjKnKXtyjbsor"
```

---

### Task 7: Visual check on the real app

- [ ] **Step 1: Start the app on 3001** (`rm -rf .next` first if a build ran): `APP_ORIGIN=http://localhost:3001 CORS_ALLOWED_ORIGINS=http://localhost:3001 npx next dev -p 3001`, wait for Ready.
- [ ] **Step 2: Desktop walk**: demo door, `/admin/board` at 14 days and "Next month" (28 days, bars narrow): every bar shows the rail; wide bars show plate plane, name and chip; narrow bars hide the chip then the name; unpaid bars are red-railed with "unpaid"; the today column is a teal wash; the legend reads in mono tiny; the hint shows once, "Got it" hides it, reload keeps it hidden. Screenshot each state (`save_to_disk: true`, `scale: 0.6`).
- [ ] **Step 3: Interactions**: drag a bar one day right and confirm the ghost renders and the bar dims while dragging; drag an empty stretch and confirm the selection rectangle and popover still work; click a day header and watch the zoom settle in; click a zoom bar to open the sheet.
- [ ] **Step 4: Phone width (390)**: the board scrolls inside its wrapper, the page never scrolls sideways; bars are still legible at the 140px sticky label width.
- [ ] **Step 5: Fix what the walk found** (CSS or copy only), then `npm run typecheck && npm run lint && npm test`; stop the dev server; `rm -rf .next && npm run build`. Commit as `fix(board): <what the visual check found>`.

---

### Task 8: Hand-off

- [ ] **Step 1: Whole-branch review** with `superpowers:requesting-code-review` on `feat/flow-desk-board` against `feat/flow-desk`; fix must-fixes in one wave.
- [ ] **Step 2: Do not merge, do not deploy.** Report branch, commit count, test count and screenshots. Merge order is Rudo's call: `feat/desk-money-controls` → `feat/flow-desk` → `feat/flow-desk-board` → `main`, then the manual Vercel deploy of the demo.
