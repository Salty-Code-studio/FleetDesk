import { describe, it, expect } from "vitest";
import { undoToast, once, UNDO_MS } from "@/app/admin/_ui/undo";

describe("undo toast", () => {
  it("lasts six seconds and says Undo", () => {
    const t = undoToast("Car retired.", () => {});
    expect(UNDO_MS).toBe(6000);
    expect(t).toMatchObject({ type: "success", message: "Car retired.", duration: 6000, action: { label: "Undo" } });
  });
  it("runs the revert once however often Undo is pressed", () => {
    let n = 0; const t = undoToast("x", () => { n++; });
    t.action!.onClick(); t.action!.onClick();
    expect(n).toBe(1);
  });
  it("once passes through the first call only", () => {
    let n = 0; const f = once(() => n++); f(); f(); f(); expect(n).toBe(1);
  });
});
