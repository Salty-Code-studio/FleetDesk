import { describe, it, expect } from "vitest";
import { confirmButtonClassName } from "@/app/admin/_ui/ConfirmDialog";

/**
 * Regression coverage for the confirm-dialog accent bug: the non-danger
 * confirm button reused `btn--accent`, the single coral interface accent
 * also used for Schedule service / Save move / Year PDF, so it blended into
 * the rest of the UI instead of standing out as the affirmative action.
 *
 * Fix: non-danger confirms get a dedicated `btn--confirm` variant (the
 * solid dark-teal primary style, same family as Apply / Sign in / Check
 * in). Danger confirms (Retire / Delete / Cancel) keep the red `danger`
 * style unchanged.
 */
describe("ConfirmDialog confirm button styling", () => {
  it("gives the non-danger confirm button a distinct style, not the ubiquitous coral accent", () => {
    const className = confirmButtonClassName(false);
    expect(className).not.toContain("btn--accent");
    expect(className).toContain("btn--confirm");
  });

  it("also avoids the coral accent when danger is omitted (default OK confirms)", () => {
    const className = confirmButtonClassName(undefined);
    expect(className).not.toContain("btn--accent");
    expect(className).toContain("btn--confirm");
  });

  it("keeps destructive confirms (Retire / Delete / Cancel) on the red danger style", () => {
    const className = confirmButtonClassName(true);
    expect(className).toContain("danger");
    expect(className).not.toContain("btn--accent");
    expect(className).not.toContain("btn--confirm");
  });

  it("always includes the base btn class for both variants", () => {
    expect(confirmButtonClassName(true).split(" ")).toContain("btn");
    expect(confirmButtonClassName(false).split(" ")).toContain("btn");
  });
});
