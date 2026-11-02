/**
 * Key rules: the rental terms can mark single rules the customer must tick one
 * by one before signing. The operator writes them in the normal policy text as
 * lines that start with "[ ]", e.g.
 *
 *   [ ] No smoking or vaping in the car. Cleaning fee USD 250.
 *
 * Pure, so the check-in wizard and its tests read the same split.
 */

export interface KeyRulesSplit {
  /** The rules to tick, in the order written. */
  rules: string[];
  /** The policy text without the "[ ]" lines, for "read all terms". */
  rest: string;
}

const RULE_LINE = /^\s*\[\s?\]\s+(.+?)\s*$/;

export function splitKeyRules(body: string): KeyRulesSplit {
  const rules: string[] = [];
  const rest: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = RULE_LINE.exec(line);
    if (m) rules.push(m[1]!);
    else rest.push(line);
  }
  return { rules, rest: rest.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

/** Every rule ticked (no rules at all counts as done). */
export function allRulesTicked(rules: string[], ticked: ReadonlySet<number>): boolean {
  return rules.every((_, i) => ticked.has(i));
}
