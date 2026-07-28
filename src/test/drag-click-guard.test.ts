import { describe, it, expect } from "vitest";
import { createDragClickGuard } from "@/lib/admin/drag-click-guard";

/**
 * Regression coverage for the planning-board drag-to-move bug: dragging a
 * booking bar moved the underlying booking, but the browser's own synthetic
 * `click` (fired right after `pointerup` ends any drag) then re-opened the
 * BookingDrawer on top of it, because the bar's onClick checked the gesture
 * ref -- which `handleUp` had already nulled out *before* that click ever
 * fires. From the click handler's point of view, "just finished a real drag"
 * and "a plain click" were indistinguishable (both saw a null ref), so every
 * successful drag-move looked like it "did nothing" -- the drawer just
 * popped open instead.
 *
 * DragClickGuard is the actual fix: `handleUp` arms it exactly when the
 * gesture that just ended moved something; the bar's onClick consumes it and
 * swallows that one echo click. A genuine plain click (no preceding drag)
 * must still open the drawer as before.
 */
describe("DragClickGuard", () => {
  it("swallows the synthetic click that follows a gesture that moved", () => {
    const guard = createDragClickGuard();
    guard.armAfterMove(); // handleUp: g.moved === true
    expect(guard.consumeSuppressed()).toBe(true); // the bar's onClick: swallow it
  });

  it("lets a genuine plain click through when nothing was armed", () => {
    const guard = createDragClickGuard();
    // No armAfterMove() call -- e.g. handleUp returned early because
    // g.moved was false (a plain mousedown+mouseup with no drag).
    expect(guard.consumeSuppressed()).toBe(false);
  });

  it("only swallows ONE click per armed gesture, not every click after", () => {
    const guard = createDragClickGuard();
    guard.armAfterMove();
    expect(guard.consumeSuppressed()).toBe(true); // the drag's own echo click
    expect(guard.consumeSuppressed()).toBe(false); // a later, unrelated click opens the drawer
  });

  it("reset() drops stale armed state left by an orphaned gesture", () => {
    const guard = createDragClickGuard();
    guard.armAfterMove(); // a gesture ended having moved, but its echo click
    // never reached a guarded handler (e.g. it landed on an element with no
    // onClick) -- the next gesture's start must not leave this dangling.
    guard.reset();
    expect(guard.consumeSuppressed()).toBe(false);
  });

  it("repeated arming before a click is still consumed only once", () => {
    const guard = createDragClickGuard();
    guard.armAfterMove();
    guard.armAfterMove();
    expect(guard.consumeSuppressed()).toBe(true);
    expect(guard.consumeSuppressed()).toBe(false);
  });
});
