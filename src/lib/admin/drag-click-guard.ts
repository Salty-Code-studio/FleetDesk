/**
 * Guards a booking bar's `onClick` against the synthetic click the browser
 * still fires right after `pointerup` ends a real drag.
 *
 * The planning board drives drag-to-move (and drag-to-create) entirely from
 * raw pointer events tracked in a ref, so pointermove/up never depend on
 * React state timing. The gesture ref is nulled out synchronously inside
 * `handleUp`, as soon as the drag ends -- but the browser still queues a
 * `click` event afterward. By the time that click reaches the bar's onClick
 * handler, the gesture ref is already null, so a check like
 * `if (!gestureRef.current)` can never tell "just finished dragging this bar"
 * apart from "a plain click": both read as null. The result was every
 * drag-to-move re-opening the BookingDrawer right after the bar actually
 * moved, so the drag looked like it did nothing.
 *
 * Arm this guard once, synchronously, inside `handleUp` whenever the gesture
 * that just ended actually moved (`g.moved === true`) -- whether it was a bar
 * move or a drag-to-create selection. The bar's onClick then consumes the
 * flag: if it was armed, this click is the drag's own synthetic echo and
 * must be swallowed; otherwise it's a genuine click and the caller should
 * proceed (e.g. open the drawer).
 */
export function createDragClickGuard() {
  let armed = false;
  return {
    /** Call once, synchronously, when a pointer gesture ends having moved. */
    armAfterMove(): void {
      armed = true;
    },
    /** Call at the start of a brand-new gesture to drop any stale armed
     *  state left over from a previous gesture whose echo click never
     *  reached a guarded handler (e.g. it landed on an element with no
     *  onClick) -- so it can't wrongly swallow an unrelated later click. */
    reset(): void {
      armed = false;
    },
    /** Call from a click handler. Returns true when this click should be
     *  swallowed (it's the drag's echo) and resets the flag either way, so
     *  the next click is always judged fresh. */
    consumeSuppressed(): boolean {
      const wasArmed = armed;
      armed = false;
      return wasArmed;
    },
  };
}

export type DragClickGuard = ReturnType<typeof createDragClickGuard>;
