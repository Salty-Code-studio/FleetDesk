"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, ADMIN_MUTATED } from "../client";
import type { SetupProgress } from "@/lib/admin/setup-progress";
import "./setup-checklist.css";

function useSetupProgress(): SetupProgress | null {
  const [p, setP] = useState<SetupProgress | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchNow = () => apiGet<SetupProgress>("/api/admin/setup-progress")
      .then((r) => { if (live) setP(r); })
      .catch(() => { /* quiet: keep the last checklist, or none */ });
    // Saving a setting fires several writes in a row; refetch once they settle.
    const onMutated = () => { clearTimeout(timer); timer = setTimeout(fetchNow, 250); };
    void fetchNow();
    window.addEventListener(ADMIN_MUTATED, onMutated);
    return () => { live = false; clearTimeout(timer); window.removeEventListener(ADMIN_MUTATED, onMutated); };
  }, []);
  return p;
}

/** Setup checklist shown under the Setup tabs. Renders nothing until loaded or on error. */
export function SetupChecklist() {
  const p = useSetupProgress();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!p) return null;

  if (p.pct >= 100) return <p className="su-ready">Your desk is ready.</p>;

  const nextKey = p.next?.key;
  return (
    <section className="su" aria-label="Setup progress">
      <h2 className="su-head">Your desk is {p.pct}% ready</h2>
      <div className="su-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.pct} aria-label="Desk setup">
        <i style={{ width: `${p.pct}%` }} />
      </div>
      <ul className="su-list">
        {p.items.map((it) => {
          const expanded = !it.done && (open[it.key] ?? it.key === nextKey);
          return (
            <li key={it.key} className={`su-item${it.done ? " is-done" : ""}`}>
              {it.done ? (
                <span className="su-row">
                  <span className="su-tick" aria-hidden="true">&#10003;</span>
                  <span className="su-label">{it.label}</span>
                  <span className="su-sr">Done</span>
                </span>
              ) : (
                <>
                  <button type="button" className="su-row su-toggle" aria-expanded={expanded}
                    onClick={() => setOpen((o) => ({ ...o, [it.key]: !expanded }))}>
                    <span className="su-dot" aria-hidden="true" />
                    <span className="su-label">{it.label}</span>
                  </button>
                  {expanded && (
                    <div className="su-body">
                      <p className="su-hint">{it.hint}</p>
                      {it.key === nextKey && it.href && <Link className="su-next" href={it.href}>Do this next</Link>}
                    </div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** One quiet line for Today. Owners only; the caller gates on role. */
export function SetupHook() {
  const p = useSetupProgress();
  if (!p || p.pct >= 100 || !p.next) return null;
  return (
    <p className="su-hook">
      Your desk is {p.pct}% ready. Next:{" "}
      {p.next.href ? <Link href={p.next.href}>{p.next.label}</Link> : p.next.label}.
    </p>
  );
}
