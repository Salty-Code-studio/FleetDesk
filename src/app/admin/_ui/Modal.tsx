"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { useOverlay } from "./useOverlay";

export type ModalSize = "sm" | "md" | "lg";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Footer area, e.g. action buttons. Renders in a divided footer row. */
  footer?: ReactNode;
  size?: ModalSize;
  /** Optional short line under the title. */
  description?: string;
}

/**
 * Accessible centered dialog. role="dialog" + aria-modal, labelled by its title,
 * focus-trapped, Escape + backdrop click close, body scroll lock, focus restored
 * to the trigger on close. CSS enter/leave transition. Built on the .pl-modal
 * look, elevated into the .ui-modal scope.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
  description,
}: ModalProps) {
  // Keep the node mounted through the leave transition.
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const { panelRef } = useOverlay(mounted, onClose);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Next frame: flip to visible so the CSS transition runs.
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), 200);
    return () => clearTimeout(t);
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      className={`ui-overlay${visible ? " is-in" : ""}`}
      onMouseDown={(e) => {
        // Backdrop close only when the press starts on the backdrop itself.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`ui-modal ui-modal--${size}${visible ? " is-in" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
      >
        <div className="ui-modal__head">
          <div>
            <h2 className="ui-modal__title" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="ui-modal__desc" id={descId}>
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="ui-iconbtn"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
        <div className="ui-modal__body">{children}</div>
        {footer ? <div className="ui-modal__foot">{footer}</div> : null}
      </div>
    </div>
  );
}
