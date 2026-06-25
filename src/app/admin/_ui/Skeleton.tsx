"use client";

import type { CSSProperties } from "react";

export interface SkeletonProps {
  /** CSS width, e.g. "100%" or 120. Defaults to full width. */
  width?: number | string;
  /** CSS height, e.g. 16. */
  height?: number | string;
  /** Pill shape for tags/avatars. */
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Shimmer placeholder. The shimmer is a pure CSS animation that respects
 * prefers-reduced-motion (it falls back to a static tint). Decorative, so it is
 * aria-hidden.
 */
export function Skeleton({
  width = "100%",
  height = 14,
  radius = 7,
  className,
  style,
}: SkeletonProps) {
  return (
    <span
      className={`ui-skel${className ? ` ${className}` : ""}`}
      aria-hidden="true"
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

/**
 * A convenience block of skeleton table rows for loading states. Renders an
 * aria-busy region so assistive tech announces the table is loading.
 */
export function SkeletonRows({
  rows = 5,
  cols = 4,
}: {
  rows?: number;
  cols?: number;
}) {
  return (
    <div className="ui-skel-rows" role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, r) => (
        <div className="ui-skel-row" key={r}>
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} height={13} width={c === 0 ? "70%" : "45%"} />
          ))}
        </div>
      ))}
    </div>
  );
}
