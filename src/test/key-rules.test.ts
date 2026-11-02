import { describe, it, expect } from "vitest";
import { splitKeyRules, allRulesTicked } from "../lib/booking/key-rules";

const BODY = `RENTAL RULES

KEY RULES
[ ] No smoking in the car.
[] Never leave the keys in the car.
  [ ]   Bring the car back full.

FULL TERMS
1. Bonaire only.
Text with [ ] inside a line stays text.`;

describe("splitKeyRules", () => {
  it("pulls out every [ ] line as a rule, in order, trimmed", () => {
    expect(splitKeyRules(BODY).rules).toEqual([
      "No smoking in the car.",
      "Never leave the keys in the car.",
      "Bring the car back full.",
    ]);
  });

  it("keeps the rest of the text without the rule lines", () => {
    const { rest } = splitKeyRules(BODY);
    expect(rest).not.toMatch(/No smoking/);
    expect(rest).toMatch(/1\. Bonaire only\./);
    expect(rest).toMatch(/Text with \[ \] inside a line stays text\./);
  });

  it("a policy without rule lines has no rules and keeps its text", () => {
    expect(splitKeyRules("Drive nicely.")).toEqual({ rules: [], rest: "Drive nicely." });
  });
});

describe("allRulesTicked", () => {
  const rules = ["a", "b", "c"];
  it("needs every rule ticked", () => {
    expect(allRulesTicked(rules, new Set([0, 2]))).toBe(false);
    expect(allRulesTicked(rules, new Set([0, 1, 2]))).toBe(true);
  });
  it("no rules counts as done", () => expect(allRulesTicked([], new Set())).toBe(true));
});
