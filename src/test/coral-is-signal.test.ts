import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const app = path.resolve(__dirname, "../app");
const read = (p: string) => readFileSync(path.join(app, p), "utf8");

/** Rules allowed to use coral: tap targets. Everything else is ink. */
const ALLOWED = [
  ".btn--accent", ".btn-demo", ".td-row__do", ".td-cta", ":focus-visible", ".nbell__badge",
  ".ui-palette__icon", ".auth-brand::before", ".logo-mark", ".td-row__who:focus-visible",
  ".nbell__mark", // "mark all read" button text, a tap target
  ".brand-dot", ".side .logo b", // brand marks, not statuses
  ".side::after", "body::before", // decorative hairline and ambient wash
  ":root", // token aliases (--orange: var(--coral))
];

function coralRules(css: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  css = css.replace(/\/\*[\s\S]*?\*\//g, ""); // comments would leak into selectors
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
