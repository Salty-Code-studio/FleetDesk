import { describe, it, expect } from "vitest";
import { ANGLES, pendingReturnPhotoAngles } from "../app/admin/(shell)/inspect/wizard-ui";

/**
 * Regression for: check-out should only require return photos where there is
 * NEW damage. `pendingReturnPhotoAngles` is the pure "can advance" helper the
 * checkout wizard's Step 1 gate is built on.
 */
describe("pendingReturnPhotoAngles", () => {
  const allSame = Object.fromEntries(ANGLES.map((a) => [a.id, "same" as const]));

  it("all angles marked same as pickup: can proceed with zero return photos", () => {
    const pending = pendingReturnPhotoAngles(allSame, () => false);
    expect(pending).toEqual([]);
  });

  it("one angle marked new damage without a photo: blocks advancing", () => {
    const choices = { ...allSame, front: "new" as const };
    const pending = pendingReturnPhotoAngles(choices, () => false);
    expect(pending).toEqual(["front"]);
  });

  it("that same angle once photographed: allows advancing", () => {
    const choices = { ...allSame, front: "new" as const };
    const pending = pendingReturnPhotoAngles(choices, (id) => id === "front");
    expect(pending).toEqual([]);
  });

  it("does not demand photos for angles left as same, even alongside a new one", () => {
    const choices = { ...allSame, front: "new" as const, back: "new" as const };
    // only "back" has been photographed so far
    const pending = pendingReturnPhotoAngles(choices, (id) => id === "back");
    expect(pending).toEqual(["front"]);
  });
});
