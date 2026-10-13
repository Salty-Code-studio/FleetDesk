# Flow Desk Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the foundation of the Yabi "Flow desk" redesign: one token file, one font module, coral as the only signal colour, a verb-based desk shell with the Yabi wordmark, and a new Today home screen that lists the day's handovers, returns and unpaid rentals as a queue the operator clears.

**Architecture:** Presentation and shell only. Every booking, payment and inspection behaviour stays as it is; the 500+ logic tests must stay green. New code is one pure module (`src/lib/admin/today.ts`) with its own tests, one thin DB loader, one API route, and one client page. The planning board moves from `/admin` to `/admin/board` unchanged. Tokens move to a root `tokens.css` that the three existing scopes alias, so nothing restyles by accident.

**Tech Stack:** Next.js 15 App Router, React 19, plain CSS with custom properties (no Tailwind, no component library), Drizzle + Postgres (PGlite in tests), Vitest (node environment, no DOM), strict CSP (fonts via `next/font/google` only, no CDN scripts or styles).

**Spec:** `docs/superpowers/specs/2026-10-14-yabi-flow-desk-design.html` (the brief; chapters "Game, not work", "Screen by screen" and "Build plan"). Reel transcript: `docs/superpowers/specs/2026-10-14-ayoships-reel-transcript.txt`.

## Global Constraints

- Strict CSP from `src/lib/http/security-headers.ts`: `font-src 'self'`, no CDN scripts, styles or icons. Fonts only through `next/font/google`. Motion only through CSS.
- Every visible string: no em-dashes, no numbered labels like "01 / 03", no "3 of 6" style counters in UI copy (a progress bar with "2 of 5 done" is allowed on Today because it is live state, not decoration).
- Coral `#FF6F59` (`--signal`) means "tap this" and nothing else. Status colours stay ink (teal, amber, green, red) and never use coral.
- Premium, not cartoon: hairlines, soft shadows, tone on tone. No mascots, badges, confetti, points.
- Behaviour freeze: no API contract changes except the new `GET /api/admin/today`. No schema changes.
- The confirm-dialog class contract is pinned by `src/test/confirm-dialog.test.ts`: `confirmButtonClassName()` must keep returning `btn--confirm` / `danger` and never `btn--accent`.
- `src/components/ui/MoneyInput.tsx` must not move (pinned by `src/test/money-input.test.ts`).
- Role rules: staff see Today, Board, Fleet. Owners see everything. The API guards enforce this server-side; the nav only hides.
- Branch: `feat/flow-desk` off `feat/desk-money-controls`. Commit after every task with the attribution lines from the session reminder.
- Run `npm run typecheck && npm run lint && npm test` before every commit that touches `.ts`/`.tsx`.
- Out of scope for this phase (deferred to the Booking sheet phase, where each reversal gets its own endpoint): the undo toast that replaces confirm dialogs. Phase 1 keeps `useConfirm` as is.

## Review Focus

1. A same-day rental (pickup 09:00, return 17:00 today) must appear on Today exactly once, as a handover, never as both a handover and a return. Test in Task 5.
2. A picked-up rental whose return date was yesterday is overdue: it must appear at the top of Today even though neither of its dates is today. Test in Task 5 and Task 6.
3. A pickup at 23:30 Aruba time is today in Aruba but tomorrow in UTC. Today must use the Aruba day, never the UTC day. Test in Task 5.
4. A cancelled booking dated today must never appear. Test in Task 6.
5. Today with nothing to do must render the designed empty state with a working link to the board, and the hero must say so in plain words, not show "0 go out today" as the huge number. Covered by the manual check in Task 9 and the `buildToday` `total === 0` test in Task 5.

---

### Task 0: Branch

**Files:** none

- [ ] **Step 1: Confirm the base branch is clean and create the feature branch**

Run:
```bash
cd ~/Desktop/SaltyCode/04-Products/saltycodestudio-products/fleetdesk
git status --short
git checkout -b feat/flow-desk feat/desk-money-controls
git branch --show-current
```
Expected: `git status --short` shows only the two untracked spec files under `docs/superpowers/specs/` and `.dev-db.broken-2026-09-09/`. The last line prints `feat/flow-desk`.

- [ ] **Step 2: Commit the spec files so the plan travels with the branch**

```bash
git add docs/superpowers/specs/2026-10-14-yabi-flow-desk-design.html docs/superpowers/specs/2026-10-14-ayoships-reel-transcript.txt docs/superpowers/plans/2026-10-14-flow-desk-phase-1.md
git commit -m "docs: add the Flow desk design brief, reel transcript and phase 1 plan

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HVdmWTpmwzjKnKXtyjbsor"
```

---

### Task 1: One font module

The same 25-line `next/font/google` block is copied into four layouts. Put it in one module. This is a pure refactor; the rendered fonts do not change.

**Files:**
- Create: `src/app/fonts.ts`
- Modify: `src/app/admin/(shell)/layout.tsx:4-32`
- Modify: `src/app/admin/(auth)/layout.tsx:2-29`
- Modify: `src/app/(public)/layout.tsx:3-30`
- Modify: `src/app/(marketing)/layout.tsx:4-29`
- Test: `src/test/fonts-single-source.test.ts`

**Interfaces:**
- Produces: `export const fontVars: string` from `src/app/fonts.ts`, the space-joined class names that set `--font-display`, `--font-mono`, `--font-body`.

- [ ] **Step 1: Write the failing guard test**

```ts
// src/test/fonts-single-source.test.ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Every .ts/.tsx file under src/app, recursively. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("fonts have one source", () => {
  it("only src/app/fonts.ts imports next/font/google", () => {
    const root = path.resolve(__dirname, "../app");
    const offenders = walk(root)
      .filter((f) => readFileSync(f, "utf8").includes("next/font/google"))
      .map((f) => path.relative(root, f));
    expect(offenders).toEqual(["fonts.ts"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/test/fonts-single-source.test.ts`
Expected: FAIL. The offenders array lists the four layouts and `fonts.ts` is missing.

- [ ] **Step 3: Create the font module**

```ts
// src/app/fonts.ts
import { Space_Grotesk, JetBrains_Mono, Inter } from "next/font/google";

// Self-hosted at build time via next/font/google: served from 'self' with an
// inline @font-face, so they satisfy the strict CSP (font-src 'self'). This is
// the ONLY place next/font may be called (guarded by
// src/test/fonts-single-source.test.ts). Every layout applies `fontVars` to its
// root wrapper so the CSS variables resolve for that subtree.
const display = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  weight: ["400", "500", "600", "700"],
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
  weight: ["400", "500", "600"],
});

const body = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
  weight: ["400", "500", "600", "700"],
});

export const fontVars = `${display.variable} ${mono.variable} ${body.variable}`;
```

- [ ] **Step 4: Replace the block in each of the four layouts**

In `src/app/admin/(shell)/layout.tsx` delete the `import { Space_Grotesk, JetBrains_Mono, Inter } from "next/font/google";` line, the comment block that starts `// Self-hosted at build time`, the three `const display/mono/body = ...` declarations and the `const fontVars = ...` line. Add after the other imports:
```ts
import { fontVars } from "@/app/fonts";
```

Do the same in `src/app/admin/(auth)/layout.tsx`, `src/app/(public)/layout.tsx` and `src/app/(marketing)/layout.tsx`. Each file keeps using `fontVars` exactly where it did.

- [ ] **Step 5: Run the guard test and the type check**

Run: `npx vitest run src/test/fonts-single-source.test.ts && npm run typecheck`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/fonts.ts "src/app/admin/(shell)/layout.tsx" "src/app/admin/(auth)/layout.tsx" "src/app/(public)/layout.tsx" "src/app/(marketing)/layout.tsx" src/test/fonts-single-source.test.ts
git commit -m "refactor(fonts): load next/font once from src/app/fonts.ts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HVdmWTpmwzjKnKXtyjbsor"
```

---

### Task 2: One token file

Tokens are declared three times with different names (`:root` in admin.css, `.pub` in public.css, `.mkt` in marketing.css). Move the palette, type scale and motion to `src/app/tokens.css`, loaded from the root layout, and make the three scopes alias it. Nothing visible changes in this task. The new names (`--signal`, `--fs-huge`, `--fs-tiny`) are what later tasks build on.

**Files:**
- Create: `src/app/tokens.css`
- Modify: `src/app/layout.tsx`
- Modify: `src/app/admin/admin.css:15-63` (the `:root` block)
- Modify: `src/app/(public)/public.css:5-33` (the `.pub` token block)
- Modify: `src/app/(marketing)/marketing.css:5-40` (the `.mkt` token block)
- Test: `src/test/tokens-single-source.test.ts`

**Interfaces:**
- Produces CSS custom properties on `:root`, used by every later task: `--sand --sand-2 --panel --fill --line --line-soft --teal --teal-700 --teal-600 --ink --ink-soft --ink-mute --coral --coral-600 --sky --signal --signal-ink --ok --ok-bg --danger --danger-bg --amber --amber-bg --pickup --overdue --fs-huge --fs-big --fs-body --fs-small --fs-tiny --radius --radius-sm --ease --dur-fast --dur-base --shadow-sm --shadow-md --shadow-lg --font-display --font-mono --font-body`.

- [ ] **Step 1: Write the failing guard test**

```ts
// src/test/tokens-single-source.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const app = path.resolve(__dirname, "../app");
const read = (p: string) => readFileSync(path.join(app, p), "utf8");

const CORE = ["--sand", "--panel", "--teal", "--ink", "--coral", "--signal", "--signal-ink", "--fs-huge", "--fs-tiny", "--ease"];

describe("design tokens have one source", () => {
  const tokens = read("tokens.css");

  it("tokens.css declares every core token on :root", () => {
    for (const t of CORE) expect(tokens, t).toMatch(new RegExp(`${t}\\s*:`));
  });

  it("the signal colour is coral and only coral", () => {
    expect(tokens).toMatch(/--signal:\s*var\(--coral\)/);
  });

  it("admin, public and marketing no longer hardcode the palette hexes", () => {
    const hexes = ["#F2EBDD", "#FCFAF4", "#0E3A40", "#FF6F59", "#1C2B2E"];
    for (const file of ["admin/admin.css", "(public)/public.css", "(marketing)/marketing.css"]) {
      const css = read(file).toUpperCase();
      for (const hex of hexes) expect(css, `${file} still declares ${hex}`).not.toContain(hex);
    }
  });

  it("the root layout loads tokens.css", () => {
    expect(read("layout.tsx")).toContain('import "./tokens.css"');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/test/tokens-single-source.test.ts`
Expected: FAIL with `ENOENT ... tokens.css`.

- [ ] **Step 3: Create tokens.css**

```css
/* src/app/tokens.css
   Yabi design tokens. ONE source for every scope (admin shell, public booking,
   marketing). The scopes alias these; they never redeclare a hex.
   Palette: Sand & Surf. Coral is the SIGNAL colour: it means "tap this" and
   nothing else. Status is ink (teal, amber, green, red), never coral.
   Guarded by src/test/tokens-single-source.test.ts. */
:root {
  /* canvas + surfaces */
  --sand:      #F2EBDD;
  --sand-2:    #EAE0CD;
  --panel:     #FCFAF4;
  --fill:      #F4EEE1;
  --line:      #E3DAC8;
  --line-soft: #EDE5D6;

  /* ink */
  --teal:      #0E3A40;
  --teal-700:  #0A2C31;
  --teal-600:  #14474E;
  --ink:       #1C2B2E;
  --ink-soft:  #586A6D;
  --ink-mute:  #8B9B9D;

  /* accents */
  --coral:     #FF6F59;
  --coral-600: #F2563F;
  --coral-lift:#FF7D68;
  --sky:       #4FA8C9;

  /* THE signal colour. Only buttons and controls the user should tap use it. */
  --signal:     var(--coral);
  --signal-600: var(--coral-600);
  --signal-ink: var(--teal-700);

  /* status (ink, never signal) */
  --ok:        #2E7D5B;
  --ok-bg:     #E2F0E7;
  --danger:    #C0473A;
  --danger-bg: #F6E3DF;
  --amber:     #C98A33;
  --amber-bg:  #F6E9CF;
  --pickup:    #2C5F8A;
  --overdue:   #8A2C2C;

  /* type scale: skip the middle sizes. One huge thing, everything else small. */
  --fs-huge:   clamp(2.75rem, 7vw, 4.5rem);
  --fs-big:    1.6rem;
  --fs-body:   .95rem;
  --fs-small:  .82rem;
  --fs-tiny:   .7rem;

  /* fonts: next/font sets the hashed families on each layout wrapper; these are
     the literal fallbacks so var() resolves on any surface. */
  --font-display-fallback: "Space Grotesk", system-ui, sans-serif;
  --font-mono-fallback:    "JetBrains Mono", ui-monospace, Menlo, monospace;
  --font-body-fallback:    "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-display: var(--font-display-fallback);
  --font-mono:    var(--font-mono-fallback);
  --font-body:    var(--font-body-fallback);

  /* shape + motion */
  --radius:    14px;
  --radius-sm: 10px;
  --radius-lg: 18px;
  --ease:      cubic-bezier(.22,.61,.36,1);
  --dur-fast:  .12s;
  --dur-base:  .2s;
  --shadow-sm: 0 1px 2px rgba(14,58,64,.06), 0 1px 8px rgba(14,58,64,.05);
  --shadow-md: 0 12px 30px -14px rgba(14,58,64,.22);
  --shadow-lg: 0 24px 60px -22px rgba(14,58,64,.30);
}
```

- [ ] **Step 4: Load it from the root layout**

Replace `src/app/layout.tsx` with:
```tsx
import type { ReactNode } from "react";
import "./tokens.css";

export const metadata = {
  title: "FleetDesk",
  description: "FleetDesk booking platform.",
};

// Minimal root layout. tokens.css is the one source of design tokens for every
// scope below (admin shell, public booking, marketing); see tokens.css.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```
(The title is renamed in Task 8, not here.)

- [ ] **Step 5: Replace the admin `:root` block with aliases**

In `src/app/admin/admin.css` replace everything from `:root {` through the closing `}` of that block (lines 15 to 63, ending after `--ease: cubic-bezier(.22,.61,.36,1);`) with:
```css
:root {
  /* Palette, type scale, fonts and motion live in src/app/tokens.css.
     Only legacy aliases stay here so old var() usages keep resolving. */
  --blue: var(--teal);
  --blue-dark: var(--teal-700);
  --orange: var(--coral);
  --navy: var(--teal);
  --surface: var(--fill);
}
```

- [ ] **Step 6: Alias the public scope**

In `src/app/(public)/public.css` replace the token declarations inside `.pub {` (from `/* canvas + surfaces */` through `--shadow-md: ...;`) with:
```css
  /* Tokens come from src/app/tokens.css. The public scope only overrides the
     status pair, which needs more contrast on warm sand. */
  --ok: #0F7B4D;
  --danger: #B3402F;
  --radius: 16px;
```
Keep the `min-height`, `color`, `background`, `font-family`, `font-size`, `line-height` and smoothing lines that follow.

- [ ] **Step 7: Alias the marketing scope**

In `src/app/(marketing)/marketing.css` replace the token declarations inside `.mkt {` (from `/* canvas + surfaces */` through `--shadow-lg: ...;`) with:
```css
  /* Tokens come from src/app/tokens.css. Marketing kept its own names; map
     them here so the 1,300 lines below need no edits. */
  --warm-sand: var(--sand);
  --deep-teal: var(--teal);
  --surf-coral: var(--coral);
  --sky-blue: var(--sky);

  /* rhythm (marketing only) */
  --shell: 1140px;
  --gutter: clamp(1.25rem, 4vw, 2.5rem);
  --radius: 16px;
  --radius-lg: 24px;
  --section-y: clamp(4rem, 9vw, 7.5rem);
```
Keep the `color`, `background`, `font-family`, `font-size`, `line-height` and smoothing lines that follow.

- [ ] **Step 8: Check nothing else in the three files declares a palette hex**

Run:
```bash
grep -nEi "#(F2EBDD|FCFAF4|0E3A40|FF6F59|1C2B2E)" src/app/admin/admin.css "src/app/(public)/public.css" "src/app/(marketing)/marketing.css"
```
Expected: no output. If a line appears, replace that literal with the matching `var(--…)`.

- [ ] **Step 9: Run the guard test, type check and build**

Run: `npx vitest run src/test/tokens-single-source.test.ts && npm run typecheck && npm run build`
Expected: PASS, tsc clean, build OK. The build is the only thing that catches a CSS import problem in a layout.

- [ ] **Step 10: Commit**

```bash
git add src/app/tokens.css src/app/layout.tsx src/app/admin/admin.css "src/app/(public)/public.css" "src/app/(marketing)/marketing.css" src/test/tokens-single-source.test.ts
git commit -m "refactor(tokens): one tokens.css for every scope, signal colour named

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HVdmWTpmwzjKnKXtyjbsor"
```

---

### Task 3: Signal colour discipline

Today two colours compete for "tap this": solid teal (`.btn`: Apply, Sign in, Month PDF) and coral (`.btn--accent`: Schedule service, Year PDF, Continue). After this task the default `.btn` is a quiet secondary (panel fill, teal text, hairline) and `.btn--accent` is the one signal. One coral control per view.

**Files:**
- Modify: `src/app/admin/admin.css` (`.btn` family, `.btn-demo`, `.side a.active::before`)
- Modify: `src/app/admin/(auth)/login/page.tsx:86,117` (the two Sign in buttons)
- Modify: `src/app/admin/(shell)/reports/page.tsx:120,231` (retry and Year PDF become secondary)

**Interfaces:**
- Produces: `.btn` = secondary, `.btn--accent` = signal (unchanged name, so the 40 existing call sites keep working), `.btn--confirm` and `.btn.danger` unchanged (pinned by test).

- [ ] **Step 1: Restyle the button family in admin.css**

Replace the block from `/* ---------- buttons ---------- */` through `.btn.danger { ... }` with:
```css
/* ---------- buttons ----------
   Discipline: coral is the SIGNAL colour and means "tap this". Exactly one
   .btn--accent per view. Everything else is ink and paper: the default .btn is
   a quiet secondary. Confirm dialogs keep solid teal (.btn--confirm, pinned by
   confirm-dialog.test.ts) because a dialog is its own view. */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: .45rem; width: 100%;
  padding: .72rem 1rem; border: 1px solid var(--line); border-radius: 10px;
  background: var(--panel); color: var(--teal);
  font-family: var(--font-display); font-weight: 600; font-size: .95rem; letter-spacing: -0.01em; cursor: pointer;
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur-base) var(--ease), background var(--dur-base) var(--ease), border-color var(--dur-base) var(--ease), box-shadow var(--dur-base) var(--ease);
}
.btn:hover { background: var(--fill); border-color: var(--teal); transform: translateY(-1px); }
.btn:active { transform: translateY(0) scale(.99); }
.btn:disabled { opacity: .5; cursor: default; transform: none; box-shadow: none; }
/* THE signal. One per view. */
.btn--accent { background: var(--signal); color: var(--signal-ink); border-color: transparent; box-shadow: 0 8px 18px -10px rgba(255,111,89,.8); }
.btn--accent:hover { background: var(--signal-600); border-color: transparent; }
.btn--confirm { background: var(--teal); color: var(--sand); border-color: transparent; box-shadow: 0 8px 18px -10px rgba(14,58,64,.6); }
.btn--confirm:hover { background: var(--teal-700); border-color: transparent; }
.btn--quiet { background: transparent; color: var(--ink-soft); font-weight: 600; width: auto; padding: .45rem .65rem; box-shadow: none; border-color: transparent; }
.btn--quiet:hover { background: var(--fill); color: var(--teal); transform: none; border-color: transparent; }
.btn.danger { background: var(--danger); color: #fff; border-color: transparent; box-shadow: 0 8px 18px -10px rgba(192,71,58,.7); }
```

- [ ] **Step 2: Make the demo door the signal and drop the coral nav tick**

In admin.css change `.btn-demo { background: var(--coral); color: var(--teal); ... }` to:
```css
.btn-demo { background: var(--signal); color: var(--signal-ink); border-color: transparent; box-shadow: 0 8px 18px -10px rgba(255,111,89,.8); }
.btn-demo:hover { background: var(--signal-600); }
```
Change `.side a.active::before { ... background: var(--coral); }` so the bar is `background: var(--sand);` (the active page is a state, not a tap target).

- [ ] **Step 3: Sign in becomes the signal only when the demo door is absent**

In `src/app/admin/(auth)/login/page.tsx`, the owner form button on line 117:
```tsx
      <button className={DEMO_MODE ? "btn" : "btn btn--accent"} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
```
The staff form button on line 86:
```tsx
        <button className="btn btn--accent" disabled={busy || code.length !== 6}>
```

- [ ] **Step 4: Reports keeps one signal**

In `src/app/admin/(shell)/reports/page.tsx` change the retry button (line 120) from `className="btn btn--accent"` to `className="btn"` and the Year PDF link (line 231) from `className="btn btn--accent"` to `className="btn"`. The month PDF button stays `.btn`. (The Money screen gets its one signal in Phase 3.)

- [ ] **Step 5: Run the pinned test, type check and lint**

Run: `npx vitest run src/test/confirm-dialog.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean (pre-existing lint warnings only).

- [ ] **Step 6: Commit**

```bash
git add src/app/admin/admin.css "src/app/admin/(auth)/login/page.tsx" "src/app/admin/(shell)/reports/page.tsx"
git commit -m "style(admin): coral is the only signal colour, default buttons go quiet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HVdmWTpmwzjKnKXtyjbsor"
```

---

### Task 4: Verb shell, Yabi wordmark, board moves to /admin/board

The sidebar becomes five verbs: Today, Board, Fleet, Money, Setup. Policies, Add-ons & insurance, Staff and Audit log fold under Setup as a sub-nav. The planning board page moves to `/admin/board` unchanged; `/admin` gets a placeholder page here and the real Today screen in Task 7.

**Files:**
- Move: `src/app/admin/(shell)/page.tsx` → `src/app/admin/(shell)/board/page.tsx`
- Move: `src/app/admin/(shell)/dashboard.css` → `src/app/admin/(shell)/board/dashboard.css`
- Create: `src/app/admin/(shell)/page.tsx` (placeholder, replaced in Task 7)
- Create: `src/app/admin/(shell)/setup-nav.tsx`
- Modify: `src/app/admin/(shell)/side-nav.tsx`
- Modify: `src/app/admin/(shell)/layout.tsx` (logo word, tag)
- Modify: `src/app/admin/_ui/CommandPalette.tsx:57-64`
- Modify: `src/app/admin/(shell)/settings/page.tsx`, `catalog/page.tsx`, `policies/page.tsx`, `staff/page.tsx`, `audit/page.tsx` (mount `<SetupNav />`)
- Modify: `src/app/admin/(shell)/inspect/[bookingId]/checkin/page.tsx:97`, `checkout/page.tsx:109` (button label)
- Modify: `src/app/admin/admin.css` (`.setup-nav` rules)

**Interfaces:**
- Produces: `/admin/board` (the planning board), `SetupNav` component with no props.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Move the board**

```bash
cd ~/Desktop/SaltyCode/04-Products/saltycodestudio-products/fleetdesk
mkdir -p "src/app/admin/(shell)/board"
git mv "src/app/admin/(shell)/page.tsx" "src/app/admin/(shell)/board/page.tsx"
git mv "src/app/admin/(shell)/dashboard.css" "src/app/admin/(shell)/board/dashboard.css"
grep -n 'from "\.\./\|from "\./' "src/app/admin/(shell)/board/page.tsx"
```
Expected grep output names three relative imports: `"../client"`, `"./booking-drawer"`, `"./dashboard.css"`.

- [ ] **Step 2: Fix the three relative imports in board/page.tsx**

```ts
import { apiGet, api, apiPatch, apiDelete, type ApiError } from "../../client";
import { BookingDrawer } from "../booking-drawer";
import "./dashboard.css";
```

- [ ] **Step 3: Placeholder Today page so the route resolves**

```tsx
// src/app/admin/(shell)/page.tsx
// Replaced by the real Today screen in Task 7 of the phase 1 plan.
import Link from "next/link";

export default function TodayPlaceholder() {
  return (
    <>
      <h1>Today</h1>
      <p className="sub">The Today screen is on its way. <Link href="/admin/board">Open the board</Link>.</p>
    </>
  );
}
```

- [ ] **Step 4: The verb nav**

Replace `src/app/admin/(shell)/side-nav.tsx` with:
```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavLink { href: string; label: string; staff?: boolean; also?: string[] }

// Five verbs. staff: true marks the pages a staff code login may use; hiding is
// presentation only, the API role guards enforce the same list server-side.
// `also` lists the routes that count as "inside" this verb for the active state.
export const LINKS: NavLink[] = [
  { href: "/admin", label: "Today", staff: true },
  { href: "/admin/board", label: "Board", staff: true },
  { href: "/admin/fleet", label: "Fleet", staff: true },
  { href: "/admin/reports", label: "Money" },
  { href: "/admin/settings", label: "Setup", also: ["/admin/catalog", "/admin/policies", "/admin/staff", "/admin/audit"] },
];

export function isActive(link: NavLink, pathname: string): boolean {
  if (link.href === "/admin") return pathname === "/admin";
  return [link.href, ...(link.also ?? [])].some((p) => pathname.startsWith(p));
}

export function SideNav({ role }: { role: "owner" | "staff" }) {
  const pathname = usePathname();
  const visible = role === "staff" ? LINKS.filter((l) => l.staff) : LINKS;
  return (
    <nav className="side-nav">
      {visible.map((l) => {
        const active = isActive(l, pathname);
        return (
          <Link key={l.href} href={l.href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 5: Write the failing test for the active-state rule**

```ts
// src/test/side-nav-active.test.ts
import { describe, it, expect } from "vitest";
import { LINKS, isActive } from "@/app/admin/(shell)/side-nav";

const by = (label: string) => LINKS.find((l) => l.label === label)!;

describe("verb nav active state", () => {
  it("Today is active only on /admin itself", () => {
    expect(isActive(by("Today"), "/admin")).toBe(true);
    expect(isActive(by("Today"), "/admin/board")).toBe(false);
  });
  it("Setup is active on every page folded under it", () => {
    for (const p of ["/admin/settings", "/admin/catalog", "/admin/policies", "/admin/staff", "/admin/audit"]) {
      expect(isActive(by("Setup"), p), p).toBe(true);
    }
    expect(isActive(by("Setup"), "/admin/fleet")).toBe(false);
  });
  it("staff see Today, Board and Fleet only", () => {
    expect(LINKS.filter((l) => l.staff).map((l) => l.label)).toEqual(["Today", "Board", "Fleet"]);
  });
});
```
Run: `npx vitest run src/test/side-nav-active.test.ts`
Expected: PASS (the module from Step 4 already satisfies it; this test pins the rule for later phases). If vitest cannot import the `"use client"` module, add `// @vitest-environment node` at the top of the test; the directive is a no-op string in node.

- [ ] **Step 6: The Setup sub-nav**

```tsx
// src/app/admin/(shell)/setup-nav.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/catalog", label: "Add-ons & insurance" },
  { href: "/admin/policies", label: "Policies" },
  { href: "/admin/staff", label: "Staff" },
  { href: "/admin/audit", label: "Audit log" },
];

/** Sub-navigation shared by every page that lives under the Setup verb. */
export function SetupNav() {
  const pathname = usePathname();
  return (
    <nav className="setup-nav" aria-label="Setup sections">
      {TABS.map((t) => {
        const active = pathname.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

Add to `src/app/admin/admin.css`, right before `/* ---------- hub pages: panels, tables, forms ---------- */`:
```css
/* ---------- Setup sub-nav (settings, catalog, policies, staff, audit) ---------- */
.setup-nav { display: flex; gap: .3rem; flex-wrap: wrap; margin: 0 0 1.4rem; padding-bottom: .9rem; border-bottom: 1px solid var(--line); }
.setup-nav a { font-family: var(--font-display); font-weight: 600; font-size: var(--fs-small); color: var(--ink-soft); text-decoration: none; padding: .42rem .75rem; border-radius: 999px; border: 1px solid transparent; transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease); }
.setup-nav a:hover { background: var(--fill); color: var(--teal); }
.setup-nav a.active { background: var(--teal); color: var(--sand); border-color: var(--teal); }
```

- [ ] **Step 7: Mount SetupNav on the five pages**

In each of `settings/page.tsx`, `catalog/page.tsx`, `policies/page.tsx`, `staff/page.tsx`, `audit/page.tsx` add the import `import { SetupNav } from "../setup-nav";` and render `<SetupNav />` as the first element inside the page's returned fragment, before its `<h1>`. For example, in settings/page.tsx the head becomes:
```tsx
          <SetupNav />
          <h1>Settings</h1>
          <p className="sub">Fees, guardrails, and alerts. Every value here is live, no redeploy.</p>
```
Open each file to find its `<h1>` and place the component directly above it.

- [ ] **Step 8: Wordmark and palette routes**

In `src/app/admin/(shell)/layout.tsx` change the logo:
```tsx
            <span className="logo-word">Yabi</span>
            <span className="logo-tag">Desk</span>
```
In `src/app/admin/_ui/CommandPalette.tsx` replace the `NAV` array:
```ts
const NAV: Array<{ label: string; hint: string; href: string; keywords?: string }> = [
  { label: "Today", hint: "What needs you", href: "/admin", keywords: "home start dashboard handovers returns" },
  { label: "Board", hint: "Fleet planning", href: "/admin/board", keywords: "planning calendar timeline" },
  { label: "Fleet", hint: "Vehicles and rates", href: "/admin/fleet", keywords: "cars vehicles rates pricing" },
  { label: "Money", hint: "Revenue and deposits", href: "/admin/reports", keywords: "reports analytics revenue stats" },
  { label: "Setup", hint: "Operator configuration", href: "/admin/settings", keywords: "settings config preferences" },
  { label: "Add-ons & insurance", hint: "Setup", href: "/admin/catalog", keywords: "extras coverage catalog" },
  { label: "Policies", hint: "Setup", href: "/admin/policies", keywords: "terms rules legal" },
  { label: "Staff", hint: "Setup", href: "/admin/staff", keywords: "team codes" },
  { label: "Audit log", hint: "Setup", href: "/admin/audit", keywords: "history changes" },
];
```

- [ ] **Step 9: Wizards return to Today**

In `src/app/admin/(shell)/inspect/[bookingId]/checkin/page.tsx` line 97 and `checkout/page.tsx` line 109 change the label `Back to the board` to `Back to Today`. The `router.push("/admin")` calls stay.

- [ ] **Step 10: Type check, lint, full test run, build**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all green. The build must list `/admin` and `/admin/board` as routes.

- [ ] **Step 11: Commit**

```bash
git add -A src/app/admin src/test/side-nav-active.test.ts
git commit -m "feat(shell): verb nav (Today, Board, Fleet, Money, Setup), Yabi wordmark, board at /admin/board

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HVdmWTpmwzjKnKXtyjbsor"
```

---

### Task 5: Today queue, pure logic

The Today screen is a queue. This module turns bookings into queue items with no database and no React, so the rules are unit-tested on their own. Mirrors `paid-state.ts` and `bar-span.ts` in style.

**Files:**
- Create: `src/lib/admin/today.ts`
- Test: `src/test/today-queue.test.ts`

**Interfaces:**
- Consumes: `arubaDateOf`, `arubaTimeOf`, `parseTs` from `@/lib/time/format`.
- Produces:
```ts
export type TodayKind = "overdue" | "return" | "handover" | "unpaid";
export interface TodayBookingInput {
  id: string; startAt: string; endAt: string; status: string;
  customerName: string; customerEmail: string;
  plate: string; vehicleName: string;
  unpaid: boolean; balanceDueCents: number; paidNote: string | null;
}
export interface TodayItem {
  bookingId: string; kind: TodayKind; at: string; time: string;
  customer: string; vehicle: string; plate: string;
  done: boolean; action: string; href: string | null;
  unpaid: boolean; note: string | null;
}
export interface TodayBoard {
  day: string; items: TodayItem[];
  goingOut: number; comingBack: number; unpaid: number; done: number; total: number;
}
export function buildToday(bookings: TodayBookingInput[], day: string, nowIso: string): TodayBoard
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/test/today-queue.test.ts
import { describe, it, expect } from "vitest";
import { buildToday, type TodayBookingInput } from "@/lib/admin/today";
import { atAruba } from "@/lib/time/format";

const day = "2028-03-10";
const now = atAruba(day, "08:00");
const at = (d: string, t: string) => atAruba(d, t);

function booking(over: Partial<TodayBookingInput> & { id: string }): TodayBookingInput {
  return {
    startAt: at(day, "09:00"), endAt: at("2028-03-13", "09:00"), status: "confirmed",
    customerName: "Kim Martinus", customerEmail: "kim@example.com",
    plate: "DEMO-001", vehicleName: "Economy Hatchback",
    unpaid: false, balanceDueCents: 0, paidNote: null,
    ...over,
  };
}

describe("buildToday", () => {
  it("lists a confirmed pickup today as a handover with the check-in link", () => {
    const b = buildToday([booking({ id: "a" })], day, now);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ kind: "handover", time: "09:00", action: "Start handover", href: "/admin/inspect/a/checkin", done: false });
    expect(b.goingOut).toBe(1);
  });

  it("a pending pickup today must be confirmed first and opens the sheet", () => {
    const b = buildToday([booking({ id: "a", status: "pending" })], day, now);
    expect(b.items[0]).toMatchObject({ kind: "handover", action: "Confirm first", href: null });
  });

  it("a picked-up pickup today is a done handover", () => {
    const b = buildToday([booking({ id: "a", status: "picked_up" })], day, now);
    expect(b.items[0]).toMatchObject({ kind: "handover", done: true, action: "Handed over" });
    expect(b.done).toBe(1);
  });

  it("a rental returning today is a return with the check-out link", () => {
    const b = buildToday([booking({ id: "r", status: "picked_up", startAt: at("2028-03-07", "09:00"), endAt: at(day, "16:00") })], day, now);
    expect(b.items[0]).toMatchObject({ kind: "return", time: "16:00", action: "Check in", href: "/admin/inspect/r/checkout", done: false });
    expect(b.comingBack).toBe(1);
  });

  it("a completed rental that returned today is a done return", () => {
    const b = buildToday([booking({ id: "r", status: "completed", startAt: at("2028-03-07", "09:00"), endAt: at(day, "16:00") })], day, now);
    expect(b.items[0]).toMatchObject({ kind: "return", done: true, action: "Back" });
  });

  it("a same-day rental appears once, as a handover", () => {
    const b = buildToday([booking({ id: "s", startAt: at(day, "09:00"), endAt: at(day, "17:00") })], day, now);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]!.kind).toBe("handover");
  });

  it("an overdue rental from yesterday sorts first even though no date is today", () => {
    const b = buildToday([
      booking({ id: "a" }),
      booking({ id: "o", status: "picked_up", startAt: at("2028-03-05", "09:00"), endAt: at("2028-03-09", "16:00") }),
    ], day, now);
    expect(b.items.map((i) => i.bookingId)).toEqual(["o", "a"]);
    expect(b.items[0]).toMatchObject({ kind: "overdue", action: "Check in", href: "/admin/inspect/o/checkout" });
    expect(b.comingBack).toBe(1);
  });

  it("a 23:30 Aruba pickup is today in Aruba even though it is tomorrow in UTC", () => {
    const b = buildToday([booking({ id: "late", startAt: at(day, "23:30"), endAt: at("2028-03-12", "09:00") })], day, now);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]!.time).toBe("23:30");
  });

  it("an unpaid rental with nothing else today is a Take payment item", () => {
    const b = buildToday([booking({ id: "u", status: "picked_up", startAt: at("2028-03-05", "09:00"), endAt: at("2028-03-14", "09:00"), unpaid: true, balanceDueCents: 12000, paidNote: "Unpaid: $120.00 still due" })], day, now);
    expect(b.items[0]).toMatchObject({ kind: "unpaid", action: "Take payment", href: null, unpaid: true, note: "Unpaid: $120.00 still due" });
    expect(b.unpaid).toBe(1);
  });

  it("a return that is also unpaid stays one item, flagged unpaid", () => {
    const b = buildToday([booking({ id: "ru", status: "picked_up", startAt: at("2028-03-07", "09:00"), endAt: at(day, "16:00"), unpaid: true, balanceDueCents: 5000, paidNote: "Unpaid: $50.00 still due" })], day, now);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ kind: "return", unpaid: true });
    expect(b.unpaid).toBe(1);
  });

  it("falls back to the email local part when the customer has no name", () => {
    const b = buildToday([booking({ id: "a", customerName: "" })], day, now);
    expect(b.items[0]!.customer).toBe("kim");
  });

  it("ignores bookings that do not touch today and are not overdue or unpaid", () => {
    const b = buildToday([booking({ id: "x", startAt: at("2028-03-11", "09:00"), endAt: at("2028-03-14", "09:00") })], day, now);
    expect(b.items).toHaveLength(0);
    expect(b.total).toBe(0);
  });

  it("sorts the day by time with overdue first", () => {
    const b = buildToday([
      booking({ id: "b", startAt: at(day, "14:00"), endAt: at("2028-03-12", "14:00") }),
      booking({ id: "a", startAt: at(day, "09:00"), endAt: at("2028-03-12", "09:00") }),
      booking({ id: "r", status: "picked_up", startAt: at("2028-03-07", "09:00"), endAt: at(day, "11:00") }),
    ], day, now);
    expect(b.items.map((i) => i.bookingId)).toEqual(["a", "r", "b"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/test/today-queue.test.ts`
Expected: FAIL with `Cannot find module '@/lib/admin/today'`.

- [ ] **Step 3: Implement the module**

```ts
// src/lib/admin/today.ts
/**
 * The Today queue: what needs the operator today, in time order.
 *
 * One item per booking. Priority when a booking qualifies for more than one
 * kind: overdue > return > handover > unpaid. Unpaid is also carried as a flag
 * on every item, so a return that still owes money shows once, flagged.
 *
 * Pure: no database, no React, no clock. The route passes the Aruba day and
 * "now" so the rule is unit-testable (see today-queue.test.ts).
 */
import { arubaDateOf, arubaTimeOf, parseTs } from "@/lib/time/format";

export type TodayKind = "overdue" | "return" | "handover" | "unpaid";

export interface TodayBookingInput {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
  customerName: string;
  customerEmail: string;
  plate: string;
  vehicleName: string;
  unpaid: boolean;
  balanceDueCents: number;
  paidNote: string | null;
}

export interface TodayItem {
  bookingId: string;
  kind: TodayKind;
  /** Full timestamp the item is anchored to (pickup or return). */
  at: string;
  /** HH:MM in Aruba time, for the row. */
  time: string;
  customer: string;
  vehicle: string;
  plate: string;
  done: boolean;
  /** Button label. */
  action: string;
  /** Wizard link, or null when the action opens the booking sheet. */
  href: string | null;
  unpaid: boolean;
  note: string | null;
}

export interface TodayBoard {
  day: string;
  items: TodayItem[];
  goingOut: number;
  comingBack: number;
  unpaid: number;
  done: number;
  total: number;
}

const OUT_OR_DONE = new Set(["picked_up", "completed"]);
const KIND_ORDER: Record<TodayKind, number> = { overdue: 0, return: 1, handover: 1, unpaid: 1 };

function customerLabel(b: TodayBookingInput): string {
  return b.customerName || b.customerEmail.split("@")[0]!;
}

function classify(b: TodayBookingInput, day: string, nowIso: string): Omit<TodayItem, "customer" | "vehicle" | "plate" | "unpaid" | "note" | "bookingId"> | null {
  const startsToday = arubaDateOf(b.startAt) === day;
  const endsToday = arubaDateOf(b.endAt) === day;

  if (b.status === "picked_up" && !endsToday && parseTs(b.endAt) < parseTs(nowIso)) {
    return { kind: "overdue", at: b.endAt, time: arubaTimeOf(b.endAt), done: false, action: "Check in", href: `/admin/inspect/${b.id}/checkout` };
  }
  if (startsToday && b.status === "pending") {
    return { kind: "handover", at: b.startAt, time: arubaTimeOf(b.startAt), done: false, action: "Confirm first", href: null };
  }
  if (startsToday && b.status === "confirmed") {
    return { kind: "handover", at: b.startAt, time: arubaTimeOf(b.startAt), done: false, action: "Start handover", href: `/admin/inspect/${b.id}/checkin` };
  }
  if (startsToday && OUT_OR_DONE.has(b.status)) {
    return { kind: "handover", at: b.startAt, time: arubaTimeOf(b.startAt), done: true, action: "Handed over", href: null };
  }
  if (endsToday && b.status === "picked_up") {
    return { kind: "return", at: b.endAt, time: arubaTimeOf(b.endAt), done: false, action: "Check in", href: `/admin/inspect/${b.id}/checkout` };
  }
  if (endsToday && b.status === "completed") {
    return { kind: "return", at: b.endAt, time: arubaTimeOf(b.endAt), done: true, action: "Back", href: null };
  }
  if (b.unpaid && OUT_OR_DONE.has(b.status)) {
    return { kind: "unpaid", at: b.endAt, time: arubaTimeOf(b.endAt), done: false, action: "Take payment", href: null };
  }
  return null;
}

export function buildToday(bookings: TodayBookingInput[], day: string, nowIso: string): TodayBoard {
  const items: TodayItem[] = [];
  for (const b of bookings) {
    const c = classify(b, day, nowIso);
    if (!c) continue;
    items.push({ ...c, bookingId: b.id, customer: customerLabel(b), vehicle: b.vehicleName, plate: b.plate, unpaid: b.unpaid, note: b.paidNote });
  }
  items.sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (parseTs(a.at) - parseTs(b.at)));

  return {
    day,
    items,
    goingOut: items.filter((i) => i.kind === "handover").length,
    comingBack: items.filter((i) => i.kind === "return" || i.kind === "overdue").length,
    unpaid: items.filter((i) => i.unpaid).length,
    done: items.filter((i) => i.done).length,
    total: items.length,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/test/today-queue.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin/today.ts src/test/today-queue.test.ts
git commit -m "feat(today): pure queue builder for the Today screen

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HVdmWTpmwzjKnKXtyjbsor"
```

---

### Task 6: Today loader and API route

A thin loader selects the bookings that could matter today and hands them to `buildToday`. Mirrors `getPlanning` in `src/lib/admin/planning.ts` (same joins, same `paidState` call).

**Files:**
- Create: `src/lib/admin/today-loader.ts`
- Create: `src/app/api/admin/today/route.ts`
- Test: `src/test/today-loader.test.ts`

**Interfaces:**
- Consumes: `buildToday`, `TodayBookingInput` from Task 5; `paidState` from `@/lib/admin/paid-state`; `getDb`, schema tables `bookings`, `customers`, `vehicles`.
- Produces: `export async function getToday(day: string, nowIso: string): Promise<TodayBoard>` and `GET /api/admin/today` returning `TodayBoard` as JSON for roles owner and staff.

- [ ] **Step 1: Write the failing DB test**

```ts
// src/test/today-loader.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { vehicles, customers, bookings } from "@/lib/db/schema";
import { getToday } from "@/lib/admin/today-loader";
import { atAruba } from "@/lib/time/format";

let db: Awaited<ReturnType<typeof getDb>>;
let vehicleId = "", customerId = "";
let n = 0;

const day = "2028-03-10";
const now = atAruba(day, "08:00");
const at = (d: string, t: string) => atAruba(d, t);

async function mk(status: "pending" | "confirmed" | "picked_up" | "completed" | "cancelled", startAt: string, endAt: string, amountPaidCents = 10000) {
  const [b] = await db.insert(bookings).values({
    vehicleId, customerId, startAt, endAt, bufferEndAt: endAt, status,
    priceBreakdown: { subtotalCents: 10000, currency: "USD" },
    amountPaidCents,
    paymentOption: "full", acceptedPolicyVersion: 1, acceptedAt: new Date(),
    idempotencyKey: `today-${++n}`,
  }).returning();
  return b!;
}

beforeAll(async () => {
  db = await getDb();
  await runMigrations();
  const [v] = await db.insert(vehicles).values({
    slug: "today-car", plate: "TDY-001", class: "Economy", name: "Economy Hatchback",
    seats: 5, transmission: "automatic", doors: 4,
    priceDayCents: 3500, priceWeekCents: 21000, priceMonthCents: 70000,
  }).returning();
  vehicleId = v!.id;
  const [c] = await db.insert(customers).values({ email: "today@example.com", name: "Toni Today" }).returning();
  customerId = c!.id;
});

describe("getToday", () => {
  it("returns today's handover, today's return, an overdue rental and an unpaid one, and never a cancelled booking", async () => {
    const handover = await mk("confirmed", at(day, "09:00"), at("2028-03-13", "09:00"));
    const ret = await mk("picked_up", at("2028-03-07", "09:00"), at(day, "16:00"));
    const overdue = await mk("picked_up", at("2028-03-05", "09:00"), at("2028-03-09", "16:00"));
    const unpaid = await mk("picked_up", at("2028-03-05", "09:00"), at("2028-03-14", "09:00"), 0);
    await mk("cancelled", at(day, "10:00"), at("2028-03-12", "10:00"));
    await mk("confirmed", at("2028-03-20", "10:00"), at("2028-03-22", "10:00"));

    const board = await getToday(day, now);
    const ids = board.items.map((i) => i.bookingId);
    expect(ids[0]).toBe(overdue.id);
    expect(ids).toContain(handover.id);
    expect(ids).toContain(ret.id);
    expect(ids).toContain(unpaid.id);
    expect(ids).toHaveLength(4);
    expect(board.items.find((i) => i.bookingId === handover.id)).toMatchObject({ plate: "TDY-001", vehicle: "Economy Hatchback", customer: "Toni Today" });
    expect(board.items.find((i) => i.bookingId === unpaid.id)).toMatchObject({ kind: "unpaid", unpaid: true, note: "Unpaid: $100.00 still due" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/test/today-loader.test.ts`
Expected: FAIL with `Cannot find module '@/lib/admin/today-loader'`.

- [ ] **Step 3: Implement the loader**

```ts
// src/lib/admin/today-loader.ts
/**
 * Selects the bookings that could matter today and hands them to buildToday.
 * Candidates: anything starting or ending inside the Aruba day, anything
 * picked up and past its return, and anything out or just back in the last
 * 30 days (the unpaid pool). buildToday does the classifying.
 */
import { and, eq, gt, gte, lt, inArray, or } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bookings, customers, vehicles } from "@/lib/db/schema";
import { atAruba, addHoursIso, arubaDateOf } from "@/lib/time/format";
import { paidState } from "@/lib/admin/paid-state";
import { buildToday, type TodayBoard, type TodayBookingInput } from "@/lib/admin/today";

export async function getToday(day: string, nowIso: string): Promise<TodayBoard> {
  const db = await getDb();
  const dayStart = atAruba(day, "00:00");
  const dayEnd = addHoursIso(dayStart, 24);
  const poolStart = addHoursIso(dayStart, -30 * 24);

  const rows = await db.select({
    id: bookings.id, startAt: bookings.startAt, endAt: bookings.endAt, status: bookings.status,
    amountPaidCents: bookings.amountPaidCents, priceBreakdown: bookings.priceBreakdown, paidUntil: bookings.paidUntil,
    customerName: customers.name, customerEmail: customers.email,
    plate: vehicles.plate, vehicleName: vehicles.name,
  }).from(bookings)
    .innerJoin(customers, eq(bookings.customerId, customers.id))
    .innerJoin(vehicles, eq(bookings.vehicleId, vehicles.id))
    .where(and(
      inArray(bookings.status, ["pending", "confirmed", "picked_up", "completed"]),
      or(
        and(gte(bookings.startAt, dayStart), lt(bookings.startAt, dayEnd)),
        and(gte(bookings.endAt, dayStart), lt(bookings.endAt, dayEnd)),
        and(eq(bookings.status, "picked_up"), lt(bookings.endAt, nowIso)),
        and(inArray(bookings.status, ["picked_up", "completed"]), gt(bookings.endAt, poolStart)),
      ),
    ));

  const todayLocal = arubaDateOf(nowIso);
  const input: TodayBookingInput[] = rows.map((r) => {
    const bd = (r.priceBreakdown ?? {}) as { subtotalCents?: number; currency?: string };
    const paid = paidState({
      status: r.status, paidUntil: r.paidUntil,
      subtotalCents: Number(bd.subtotalCents ?? 0), amountPaidCents: r.amountPaidCents,
      currency: bd.currency ?? "USD", todayLocal,
    });
    return {
      id: r.id, startAt: r.startAt, endAt: r.endAt, status: r.status,
      customerName: r.customerName, customerEmail: r.customerEmail,
      plate: r.plate, vehicleName: r.vehicleName,
      unpaid: paid.unpaid, balanceDueCents: paid.balanceDueCents, paidNote: paid.note,
    };
  });

  return buildToday(input, day, nowIso);
}
```
`gte` is a standard `drizzle-orm` export in the pinned version (0.45).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/test/today-loader.test.ts`
Expected: PASS. If the `inArray(..., ["pending", ...])` literal fails the enum type, cast as in planning.ts: the same literal array is used there, so it type-checks.

- [ ] **Step 5: The route**

```ts
// src/app/api/admin/today/route.ts
import { withRoute } from "@/lib/http/handler";
import { json } from "@/lib/http/respond";
import { read } from "@/lib/admin/guard";
import { getToday } from "@/lib/admin/today-loader";
import { arubaToday, arubaNowIso } from "@/lib/booking/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/today: the operator's queue for the current Aruba day.
 *  Staff opt-in: Today is the staff home surface, like the board. */
export const GET = withRoute(async (req) =>
  json(await read(req, () => getToday(arubaToday(), arubaNowIso()), { roles: ["owner", "staff"] }), req),
);
```

- [ ] **Step 6: Type check, lint, full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/admin/today-loader.ts src/app/api/admin/today/route.ts src/test/today-loader.test.ts
git commit -m "feat(today): loader and GET /api/admin/today

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HVdmWTpmwzjKnKXtyjbsor"
```

---

### Task 7: The Today screen

The home screen. Three planes in the hero (huge number behind, sentence in the middle, one coral button on top), a progress bar, and the queue. Rows open the existing BookingDrawer or link to the wizards. No new behaviour: every action already exists.

**Files:**
- Replace: `src/app/admin/(shell)/page.tsx`
- Create: `src/app/admin/(shell)/today.css`

**Interfaces:**
- Consumes: `GET /api/admin/today` (Task 6) shaped as `TodayBoard`; `BookingDrawer` from `./booking-drawer` with props `{ bookingId, onClose, onChanged }`; `apiGet`, `ApiError` from `../client`; `Skeleton`, `EmptyState`, `useToast` from `@/app/admin/_ui`.

- [ ] **Step 1: The page**

```tsx
// src/app/admin/(shell)/page.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, type ApiError } from "../client";
import { Skeleton, EmptyState, useToast } from "@/app/admin/_ui";
import type { TodayBoard, TodayItem } from "@/lib/admin/today";
import { BookingDrawer } from "./booking-drawer";
import "./today.css";

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function longDate(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

/** The hero sentence. One huge number, then the rest tiny. */
function headline(b: TodayBoard): { big: string; line: string; tail: string } {
  if (b.total === 0) return { big: "Clear", line: "Nothing needs you today.", tail: longDate(b.day) };
  const open = b.total - b.done;
  if (open === 0) return { big: "Done", line: "Everything for today is handled.", tail: longDate(b.day) };
  const big = String(b.goingOut || b.comingBack || b.total);
  const line = b.goingOut
    ? `${b.goingOut === 1 ? "goes" : "go"} out today`
    : b.comingBack
      ? `${b.comingBack === 1 ? "comes" : "come"} back today`
      : `${b.total === 1 ? "needs" : "need"} you today`;
  const parts: string[] = [];
  if (b.goingOut && b.comingBack) parts.push(`${b.comingBack} ${b.comingBack === 1 ? "return" : "returns"}`);
  if (b.unpaid) parts.push(`${b.unpaid} unpaid`);
  const tail = [longDate(b.day), ...parts].join(". ");
  return { big, line, tail };
}

/** The one signal button: the first open item's action. */
function firstOpen(b: TodayBoard): TodayItem | undefined {
  return b.items.find((i) => !i.done);
}

export default function TodayPage() {
  const [board, setBoard] = useState<TodayBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setBoard(await apiGet<TodayBoard>("/api/admin/today"));
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError).message });
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  if (loading || !board) {
    return (
      <div className="td">
        <div className="td-hero td-hero--skel"><Skeleton height={56} width="40%" /><Skeleton height={18} width="60%" /></div>
        <div className="td-queue"><Skeleton height={64} /><Skeleton height={64} /><Skeleton height={64} /></div>
      </div>
    );
  }

  const h = headline(board);
  const next = firstOpen(board);
  const pct = board.total === 0 ? 0 : Math.round((board.done / board.total) * 100);

  return (
    <div className="td">
      <section className="td-hero" aria-label="Today">
        <span className="td-hero__back" aria-hidden="true">{h.big}</span>
        <div className="td-hero__mid">
          <h1 className="td-hero__big">{h.big}<span className="td-hero__line"> {h.line}</span></h1>
          <p className="td-hero__tail">{h.tail}</p>
        </div>
        <div className="td-hero__top">
          {next && (next.href
            ? <Link className="btn btn--accent td-cta" href={next.href}>{next.action}</Link>
            : <button type="button" className="btn btn--accent td-cta" onClick={() => setSheetId(next.bookingId)}>{next.action}</button>)}
          <Link className="btn td-cta" href="/admin/board">Open board</Link>
        </div>
      </section>

      {board.total > 0 && (
        <div className="td-progress" role="progressbar" aria-valuemin={0} aria-valuemax={board.total} aria-valuenow={board.done} aria-label="Handled today">
          <i style={{ width: `${pct}%` }} />
          <span className="td-progress__label">{board.done} of {board.total} done</span>
        </div>
      )}

      {board.total === 0 ? (
        <EmptyState
          mark="~<"
          title="A clear desk"
          hint="No handovers, returns or open balances today. The board shows what is coming."
          action={<Link className="btn btn--accent" href="/admin/board">Open the board</Link>}
        />
      ) : (
        <ol className="td-queue">
          {board.items.map((it) => (
            <li key={it.bookingId} className={`td-row td-row--${it.kind}${it.done ? " is-done" : ""}`}>
              <span className="td-row__time">{it.time}</span>
              <button type="button" className="td-row__who" onClick={() => setSheetId(it.bookingId)}>
                <b>{it.customer}</b>
                <span>{it.vehicle}, {it.plate}{it.kind === "overdue" ? ", overdue" : ""}{it.unpaid && it.note ? `, ${it.note.replace(/^Unpaid: /, "")}` : ""}</span>
              </button>
              {it.done
                ? <span className="td-row__done">{it.action}</span>
                : it.href
                  ? <Link className="td-row__do" href={it.href}>{it.action}</Link>
                  : <button type="button" className="td-row__do" onClick={() => setSheetId(it.bookingId)}>{it.action}</button>}
            </li>
          ))}
        </ol>
      )}

      <BookingDrawer bookingId={sheetId} onClose={() => setSheetId(null)} onChanged={() => { void load(); }} />
    </div>
  );
}
```
Prop names are verified against the kit: `Skeleton` takes `width`, `height`, `radius`; `EmptyState` takes `title`, `hint`, `action`, `mark`.

- [ ] **Step 2: The styles**

```css
/* src/app/admin/(shell)/today.css
   Today screen. Three planes in the hero: the huge number behind, the sentence
   in the middle, the one coral button on top. Status is ink; coral only taps. */
.td { display: flex; flex-direction: column; gap: 1.4rem; max-width: 880px; }

.td-hero { position: relative; overflow: hidden; padding: 2.2rem 2rem 2rem; border-radius: var(--radius-lg); background: var(--panel); border: 1px solid var(--line); box-shadow: var(--shadow-sm); min-height: 220px; display: flex; flex-direction: column; justify-content: flex-end; gap: 1.2rem; }
.td-hero--skel { gap: .8rem; }
.td-hero__back { position: absolute; right: -.06em; bottom: -.28em; font-family: var(--font-display); font-weight: 700; font-size: clamp(9rem, 26vw, 17rem); line-height: 1; letter-spacing: -.06em; color: var(--teal); opacity: .06; pointer-events: none; user-select: none; }
.td-hero__mid { position: relative; }
.td-hero__big { margin: 0; font-family: var(--font-display); font-weight: 700; font-size: var(--fs-huge); line-height: .95; letter-spacing: -.03em; color: var(--teal); text-wrap: balance; font-variant-numeric: tabular-nums; }
.td-hero__line { font-size: .42em; font-weight: 600; letter-spacing: -.01em; }
.td-hero__tail { margin: .55rem 0 0; font-family: var(--font-mono); font-size: var(--fs-tiny); letter-spacing: .06em; text-transform: uppercase; color: var(--ink-mute); }
.td-hero__top { position: relative; display: flex; gap: .6rem; flex-wrap: wrap; }
.td-cta.btn { width: auto; padding: .7rem 1.2rem; text-decoration: none; }

.td-progress { position: relative; height: 8px; border-radius: 999px; background: var(--line-soft); overflow: visible; }
.td-progress i { display: block; height: 100%; border-radius: 999px; background: var(--teal); transition: width .4s var(--ease); }
.td-progress__label { position: absolute; right: 0; top: 14px; font-family: var(--font-mono); font-size: var(--fs-tiny); letter-spacing: .06em; text-transform: uppercase; color: var(--ink-mute); }

.td-queue { list-style: none; margin: 1.2rem 0 0; padding: 0; display: flex; flex-direction: column; gap: .6rem; }
.td-row { display: grid; grid-template-columns: 52px 1fr auto; align-items: center; gap: .9rem; padding: .8rem 1rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); box-shadow: var(--shadow-sm); transition: transform var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease), opacity var(--dur-base) var(--ease); }
.td-row:hover { transform: translateY(-1px); box-shadow: var(--shadow-md); }
.td-row.is-done { opacity: .55; }
.td-row.is-done:hover { transform: none; box-shadow: var(--shadow-sm); }
.td-row--overdue { border-color: var(--overdue); }
.td-row__time { font-family: var(--font-mono); font-size: var(--fs-small); color: var(--ink-mute); font-variant-numeric: tabular-nums; }
.td-row--overdue .td-row__time { color: var(--overdue); }
.td-row__who { all: unset; cursor: pointer; display: flex; flex-direction: column; gap: .1rem; min-width: 0; }
.td-row__who b { font-family: var(--font-display); font-weight: 600; font-size: 1rem; color: var(--teal); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.td-row__who span { font-size: var(--fs-small); color: var(--ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.td-row__who:focus-visible { outline: 2px solid var(--signal); outline-offset: 4px; border-radius: 6px; }
.td-row__do { font-family: var(--font-display); font-weight: 600; font-size: var(--fs-small); color: var(--signal-ink); background: var(--signal); border: 0; border-radius: 9px; padding: .55rem .9rem; cursor: pointer; text-decoration: none; white-space: nowrap; transition: transform var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease); }
.td-row__do:hover { background: var(--signal-600); transform: translateY(-1px); }
.td-row__do:active { transform: translateY(0) scale(.98); }
.td-row__done { font-family: var(--font-mono); font-size: var(--fs-tiny); letter-spacing: .06em; text-transform: uppercase; color: var(--ok); white-space: nowrap; }

@media (max-width: 640px) {
  .td-hero { padding: 1.6rem 1.2rem 1.4rem; min-height: 180px; }
  .td-row { grid-template-columns: 44px 1fr; }
  .td-row__do, .td-row__done { grid-column: 2; justify-self: start; }
}
@media (prefers-reduced-motion: reduce) {
  .td-row, .td-row__do, .td-progress i { transition: none; }
}
```

- [ ] **Step 3: Type check, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: green. Fix any prop-name mismatch with `Skeleton` / `EmptyState` found in Step 1.

- [ ] **Step 4: Commit**

```bash
git add "src/app/admin/(shell)/page.tsx" "src/app/admin/(shell)/today.css"
git commit -m "feat(today): the Today screen, a queue the operator clears

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HVdmWTpmwzjKnKXtyjbsor"
```

---

### Task 8: Rename to Yabi in the product

User-visible "FleetDesk" becomes "Yabi". Code comments, env defaults for email addresses, test fixtures named `operatorName` and the `fleetdesk.app` domain stay.

**Files:**
- Modify: `src/lib/site-config.ts:36`
- Modify: `src/app/layout.tsx` (metadata)
- Modify: `src/app/admin/(shell)/layout.tsx` (metadata title)
- Modify: `src/app/admin/(auth)/layout.tsx` (metadata title)
- Modify: `src/app/admin/(auth)/login/page.tsx` (two `auth-brand` paragraphs)
- Modify: `src/app/admin/(auth)/mfa/page.tsx` (3 mentions)
- Modify: `src/app/(marketing)/layout.tsx`, `page.tsx`, `pricing/page.tsx`, `early-access/page.tsx` (copy)
- Modify: `src/lib/auth/totp.ts:70` and `src/test/totp.test.ts:50`

- [ ] **Step 1: Replace the visible strings**

```bash
cd ~/Desktop/SaltyCode/04-Products/saltycodestudio-products/fleetdesk
sed -i '' 's/FleetDesk/Yabi/g' \
  src/lib/site-config.ts src/app/layout.tsx \
  "src/app/admin/(shell)/layout.tsx" "src/app/admin/(auth)/layout.tsx" \
  "src/app/admin/(auth)/login/page.tsx" "src/app/admin/(auth)/mfa/page.tsx" \
  "src/app/(marketing)/layout.tsx" "src/app/(marketing)/page.tsx" \
  "src/app/(marketing)/pricing/page.tsx" "src/app/(marketing)/early-access/page.tsx"
sed -i '' 's/issuerName = "FleetDesk Admin"/issuerName = "Yabi Desk"/' src/lib/auth/totp.ts
sed -i '' 's/FleetDesk%20Admin%3Aowner/Yabi%20Desk%3Aowner/; s/issuer=FleetDesk%20Admin/issuer=Yabi%20Desk/' src/test/totp.test.ts
grep -rn "FleetDesk" src --include='*.tsx' --include='*.ts' | grep -v "^src/test/pdf\|^src/env.ts\|format.ts\|_ui/index.ts"
```
Expected: the final grep prints nothing. (The metadata title in the shell layout now reads `Yabi Admin`; change it by hand to `Yabi Desk`.)

Note: "Yabi Desk" as the TOTP issuer only affects new enrolments; existing authenticator entries keep working because the secret is unchanged.

- [ ] **Step 2: Read the marketing copy once for sentences that no longer scan**

Run: `grep -n "Yabi" "src/app/(marketing)/page.tsx" "src/app/(marketing)/pricing/page.tsx"`. Read each hit. Fix only a sentence where the swap broke grammar (for example "a FleetDesk" never occurs, but check).

- [ ] **Step 3: Tests, type check, lint**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green, including `totp.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add -A src
git commit -m "feat(brand): the product is called Yabi

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HVdmWTpmwzjKnKXtyjbsor"
```

---

### Task 9: Visual check on the real app

No render tests exist, so this is the only visual gate. Use the local dev server with the demo door and the Claude in Chrome browser tools.

**Files:** none changed unless a defect is found.

- [ ] **Step 1: Start the app**

Run: `ls .env.local && grep -c DEMO_MODE .env.local` to confirm the local env exists and enables the demo door. Then `npm run dev` in the background and wait for `Ready`.

- [ ] **Step 2: Walk the screens at desktop width**

Open `http://localhost:3000/admin/login`, enter the demo, and screenshot: `/admin` (Today), `/admin/board`, `/admin/fleet`, `/admin/reports`, `/admin/settings`, `/admin/catalog`. Check against the brief:
- Exactly one coral control per view (Today: the hero button and the row buttons are the queue's actions, which is the allowed exception on a list; the rows are "tap this" by definition).
- Sidebar reads Today, Board, Fleet, Money, Setup, with the Yabi wordmark.
- Setup pages show the sub-nav and the active pill.
- Today hero: huge number behind, sentence, tail line, two buttons.
- Fonts render as Space Grotesk and JetBrains Mono (the eyebrow labels are mono).

- [ ] **Step 3: Walk Today at phone width**

Resize to 390 wide. Today rows stack to two lines with the action under the name. No horizontal page scroll. The sidebar becomes the sticky top bar with the five verbs.

- [ ] **Step 4: Seed one booking for today and watch the queue change**

On `/admin/board`, drag an empty stretch on a car starting today and add a rental. Return to `/admin`: the row appears as "Confirm first" (pending). Open it, Confirm in the sheet, close: the row becomes "Start handover". Follow it into the check-in wizard; "Back to Today" returns to `/admin`.

- [ ] **Step 5: Fix what the walk found, then re-run the gates**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Commit any fix as `fix(today): <what the visual check found>` with the attribution lines.

---

### Task 10: Hand-off

- [ ] **Step 1: Whole-branch review**

Use the `superpowers:requesting-code-review` skill on `feat/flow-desk` against `feat/desk-money-controls`. Address must-fix findings, commit, re-run the gates.

- [ ] **Step 2: Update the brief's status line**

In `docs/superpowers/specs/2026-10-14-yabi-flow-desk-design.html` change the hero meta `Nothing built yet, this is the decision doc` to `Phase 1 built on feat/flow-desk, awaiting review`. Commit as `docs: phase 1 status`.

- [ ] **Step 3: Do not merge, do not deploy**

Merging to `main` and the manual Vercel deploy of the public demo are Rudo's call. Report: branch name, commit count, test count, and the screenshots from Task 9.
