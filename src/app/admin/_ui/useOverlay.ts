"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Shared overlay plumbing for Modal and Drawer:
 *   - Escape closes
 *   - focus trap (Tab / Shift+Tab cycle inside the panel)
 *   - move focus into the panel on open, restore it to the trigger on close
 *   - body scroll lock while any overlay is open (ref-counted across instances)
 *
 * Presentation only. No data, no handlers beyond close. Plain React + DOM, so it
 * passes the strict CSP (no eval).
 */

// Ref-counted so stacking a Drawer over a Modal does not unlock the body early.
let lockCount = 0;
let savedOverflow = "";
let savedPaddingRight = "";

// Stack of currently-open overlay instances (Modal-over-Drawer, etc.), most
// recently opened last. Every instance independently registers a capture-phase
// `document` keydown listener, so without this only the topmost one may act
// on Escape: otherwise one keypress would fire every open overlay's onClose
// and close them all at once instead of just backing out of the top one.
const overlayStack: object[] = [];

function lockBody() {
  if (lockCount === 0 && typeof document !== "undefined") {
    const { body } = document;
    savedOverflow = body.style.overflow;
    savedPaddingRight = body.style.paddingRight;
    // Compensate for the scrollbar so the layout does not shift on lock.
    const sbw = window.innerWidth - document.documentElement.clientWidth;
    if (sbw > 0) body.style.paddingRight = `${sbw}px`;
    body.style.overflow = "hidden";
  }
  lockCount += 1;
}

function unlockBody() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0 && typeof document !== "undefined") {
    document.body.style.overflow = savedOverflow;
    document.body.style.paddingRight = savedPaddingRight;
  }
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useOverlay(
  open: boolean,
  onClose: () => void,
): { panelRef: React.RefObject<HTMLDivElement | null> } {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Stable per-instance token identifying this overlay's place in the stack.
  const tokenRef = useRef<object>({});

  const focusFirst = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const target =
      panel.querySelector<HTMLElement>("[data-autofocus]") ??
      panel.querySelector<HTMLElement>(FOCUSABLE) ??
      panel;
    target.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    // Remember what to restore focus to, then move focus into the panel.
    restoreRef.current =
      (document.activeElement as HTMLElement | null) ?? null;
    lockBody();
    // Defer one frame so the panel has rendered before we focus it.
    const raf = requestAnimationFrame(focusFirst);
    // Stable for the lifetime of this effect (tokenRef.current never changes
    // after first render) — captured locally so the cleanup below closes over
    // a plain variable instead of re-reading the ref.
    const token = tokenRef.current;
    overlayStack.push(token);

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Only the topmost open overlay backs out on Escape. A Modal opened
        // over an open Drawer (e.g. Refund/Cancel over the BookingDrawer)
        // must not also close the Drawer underneath it for the same keypress.
        if (overlayStack[overlayStack.length - 1] !== token) return;
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!active || !panel.contains(active)) {
        // Focus escaped the panel (e.g. it moved to the body): pull it back in
        // so Tab never leaks out of the open overlay.
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKeyDown, true);
      const idx = overlayStack.indexOf(token);
      if (idx !== -1) overlayStack.splice(idx, 1);
      unlockBody();
      // Restore focus to whatever opened the overlay.
      const el = restoreRef.current;
      if (el && typeof el.focus === "function") el.focus();
    };
  }, [open, focusFirst]);

  return { panelRef };
}
