"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { useOverlay } from "./useOverlay";

export type DrawerSize = "md" | "lg";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: DrawerSize;
  description?: string;
}

/**
 * Right-sliding side panel for larger forms. Shares the same a11y plumbing as
 * Modal (role="dialog", aria-modal, focus trap, Escape + backdrop close, scroll
 * lock, focus restore). The only difference is the slide-from-right transition.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
  description,
}: DrawerProps) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const { panelRef } = useOverlay(mounted, onClose);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), 260);
    return () => clearTimeout(t);
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      className={`ui-overlay ui-overlay--drawer${visible ? " is-in" : ""}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`ui-drawer ui-drawer--${size}${visible ? " is-in" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
      >
        <div className="ui-drawer__head">
          <div>
            <h2 className="ui-drawer__title" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="ui-drawer__desc" id={descId}>
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="ui-iconbtn"
            onClick={onClose}
            aria-label="Close panel"
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
        <div className="ui-drawer__body">{children}</div>
        {footer ? <div className="ui-drawer__foot">{footer}</div> : null}
      </div>
    </div>
  );
}
