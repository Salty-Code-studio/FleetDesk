"use client";

import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  hint?: string;
  /** Optional action, typically the primary button that fills the empty list. */
  action?: ReactNode;
  /** Override the default ~< logomark with custom content. */
  mark?: ReactNode;
}

/**
 * Empty-list placeholder: the ~< logomark, a title, a soft hint, and an optional
 * action button. Used when a table or list has no rows yet.
 */
export function EmptyState({ title, hint, action, mark }: EmptyStateProps) {
  return (
    <div className="ui-empty">
      <span className="ui-empty__mark" aria-hidden="true">
        {mark ?? "~<"}
      </span>
      <h3 className="ui-empty__title">{title}</h3>
      {hint ? <p className="ui-empty__hint">{hint}</p> : null}
      {action ? <div className="ui-empty__action">{action}</div> : null}
    </div>
  );
}
