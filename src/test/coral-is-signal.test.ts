import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const app = path.resolve(__dirname, "../app");
const read = (p: string) => readFileSync(path.join(app, p), "utf8");

// Guard scans the admin stylesheets listed below.
/** Exact selectors allowed to use coral: tap targets, brand marks, decoration. */
const ALLOWED = [
  ".btn--accent", ".btn-demo", ".td-row__do", ".td-cta", ".nbell__badge",
  ".ui-palette__icon", ".auth-brand::before", ".side .logo .logo-mark",
  ".td-row__who",
  ".nbell__mark", // "mark all read" button text, a tap target
  ".brand-dot", ".side .logo b", // brand marks, not statuses
  ".bd-next", ".fc-add", // tap targets created by Phase 3 tasks
];
/** Allowed only as the whole selector part. */
const ALLOWED_EXACT = [
  ":focus-visible", // global focus ring
  ":root", // token aliases (--orange: var(--coral))
  "body::before", ".side::after", // ambient wash and hairline
];

function partAllowed(part: string): boolean {
  if (ALLOWED_EXACT.includes(part)) return true;
  const base = part.replace(/:(hover|active|focus-visible|focus|disabled)/g, "");
  return ALLOWED.includes(base);
}

function coralRules(css: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  css = css.replace(/\/\*[\s\S]*?\*\//g, ""); // comments would leak into selectors
  while ((m = re.exec(css))) {
    const [, sel, body] = m;
    if (/var\(--(coral|signal|orange)[^)]*\)|rgba\(255,\s*111,\s*89|#ff6f59|#f2563f|#ff7d68/i.test(body!)) out.push(sel!.trim());
  }
  return out;
}

describe("coral is the signal colour, never a status", () => {
  for (const file of [
    "admin/admin.css", "admin/(shell)/board/dashboard.css", "admin/(shell)/today.css",
    "admin/(shell)/booking-drawer.css", "admin/(shell)/fleet/fleet.css", "admin/(shell)/reports/reports.css",
    "admin/(shell)/settings/settings.css", "admin/(shell)/catalog/catalog.css", "admin/(shell)/staff/staff.css", "admin/(shell)/setup-checklist.css",
  ]) {
    it(`${file} uses coral only on tap targets`, () => {
      const offenders = coralRules(read(file)).filter((sel) => !sel.split(",").map((x) => x.trim()).every(partAllowed));
      expect(offenders).toEqual([]);
    });
  }
});
