"use client";

import { useCallback } from "react";
import { useToast, type ToastOptions } from "./Toast";

/** How long an Undo toast stays up. */
export const UNDO_MS = 6000;

/** Wrap fn so only the first call runs. */
export function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/** Toast options for a reversible action: success message plus a one-shot Undo. */
export function undoToast(message: string, onUndo: () => void): ToastOptions {
  return {
    type: "success",
    message,
    duration: UNDO_MS,
    action: { label: "Undo", onClick: once(onUndo) },
  };
}

/** Read a message structurally (client.ts throws plain objects, not Errors). */
export function undoErrorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m.trim() !== "") return m;
  }
  return "Could not undo.";
}

/**
 * Show an Undo toast. On Undo, awaits `revert`, then confirms "Undone." or
 * shows the error message. The toast lives in the shell provider, so Undo
 * still works after the page that raised it unmounts.
 */
export function useUndo(): (message: string, revert: () => Promise<void>) => void {
  const toast = useToast();
  return useCallback(
    (message, revert) => {
      toast.show(
        undoToast(message, () => {
          void revert().then(
            () => toast.show({ type: "success", message: "Undone." }),
            (err: unknown) =>
              toast.show({
                type: "error",
                message: undoErrorMessage(err),
              }),
          );
        }),
      );
    },
    [toast],
  );
}
