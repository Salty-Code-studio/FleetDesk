"use client";

import { useEffect } from "react";

// CSP-safe scroll reveal. No external JS, no eval. We watch every element that
// opts in with the data-reveal attribute and add a "is-visible" class when it
// enters the viewport. CSS handles the actual transition. Users who prefer
// reduced motion get everything shown at once, no animation.
export default function Reveal() {
  useEffect(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>("[data-reveal]"),
    );
    if (els.length === 0) return;

    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduce || typeof IntersectionObserver === "undefined") {
      for (const el of els) el.classList.add("is-visible");
      return;
    }

    const io = new IntersectionObserver(
      (entries, obs) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            obs.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );

    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, []);

  return null;
}
