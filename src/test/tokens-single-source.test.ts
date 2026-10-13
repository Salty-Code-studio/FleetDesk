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
