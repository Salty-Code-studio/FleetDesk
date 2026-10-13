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
