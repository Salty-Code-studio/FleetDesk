"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Modal } from "./Modal";

export interface ConfirmOptions {
  title: string;
  /** Body text shown under the title. */
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Danger styling for destructive confirmations (Retire / Delete). */
  danger?: boolean;
}

export type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface ConfirmState extends ConfirmOptions {
  open: boolean;
}

const CLOSED: ConfirmState = { open: false, title: "" };

/**
 * Promise-based confirmation host. Mount once in the admin shell, then call
 * const confirm = useConfirm(); const ok = await confirm({ title, danger });
 * Resolves true on confirm, false on cancel / Escape / backdrop.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState>(CLOSED);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const settle = useCallback((value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setState((s) => ({ ...s, open: false }));
  }, []);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      // If something was already pending, treat it as cancelled.
      resolver.current?.(false);
      resolver.current = resolve;
      setState({ ...opts, open: true });
    });
  }, []);

  const api = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={api}>
      {children}
      <Modal
        open={state.open}
        onClose={() => settle(false)}
        title={state.title}
        description={state.message}
        size="sm"
        footer={
          <>
            <button
              type="button"
              className="btn btn--quiet"
              onClick={() => settle(false)}
            >
              {state.cancelLabel ?? "Cancel"}
            </button>
            <button
              type="button"
              className={`btn${state.danger ? " danger" : " btn--accent"}`}
              onClick={() => settle(true)}
              data-autofocus
            >
              {state.confirmLabel ?? (state.danger ? "Confirm" : "OK")}
            </button>
          </>
        }
      >
        <p className="ui-confirm__lead">
          {state.message ?? "This action cannot be undone."}
        </p>
      </Modal>
    </ConfirmContext.Provider>
  );
}

/** Returns a promise-based confirm() function. Must be under a ConfirmProvider. */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used within a ConfirmProvider");
  }
  return ctx;
}
