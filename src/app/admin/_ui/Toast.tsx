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

export type ToastType = "success" | "error" | "info";

export interface ToastOptions {
  type?: ToastType;
  message: string;
  /** Auto-dismiss after this many ms. Pass 0 to keep until dismissed. */
  duration?: number;
}

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  leaving: boolean;
}

export interface ToastApi {
  /** Show a toast. Returns its id so callers may dismiss it early. */
  show: (opts: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION = 4200;

const LABEL: Record<ToastType, string> = {
  success: "Success",
  error: "Error",
  info: "Info",
};

/**
 * Context-based toasts: success / error / info, auto-dismiss, stacked,
 * dismissible. Mount once near the top of the admin shell, then call
 * useToast().show({ type, message }) from any client component. Each toast is
 * its own live region: success / info announce politely (role="status"), errors
 * interrupt (role="alert", assertive). The wrapper stays aria-live="off" so the
 * announcement is never duplicated.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const remove = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      // Play the leave transition, then unmount.
      setToasts((list) =>
        list.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
      );
      const t = timers.current.get(id);
      if (t) clearTimeout(t);
      const out = setTimeout(() => remove(id), 220);
      timers.current.set(id, out);
    },
    [remove],
  );

  const show = useCallback(
    (opts: ToastOptions) => {
      const id = (idRef.current += 1);
      const type = opts.type ?? "info";
      setToasts((list) => [...list, { id, type, message: opts.message, leaving: false }]);
      const duration = opts.duration ?? DEFAULT_DURATION;
      if (duration > 0) {
        const t = setTimeout(() => dismiss(id), duration);
        timers.current.set(id, t);
      }
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/*
        The outer container is aria-live="off" so it never double-announces.
        Each toast carries its own live region instead: errors use role="alert"
        (assertive, interrupts) and success/info use role="status" (polite).
      */}
      <div className="ui-toaster" aria-live="off" aria-atomic="false">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`ui-toast ui-toast--${t.type}${t.leaving ? " is-leaving" : ""}`}
            role={t.type === "error" ? "alert" : "status"}
            aria-live={t.type === "error" ? "assertive" : "polite"}
          >
            <span className="ui-toast__mark" aria-hidden="true" />
            <div className="ui-toast__body">
              <span className="ui-toast__label">{LABEL[t.type]}</span>
              <span className="ui-toast__msg">{t.message}</span>
            </div>
            <button
              type="button"
              className="ui-toast__close"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
            >
              <span aria-hidden="true">&times;</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Access the toast API. Must be called under a ToastProvider. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
