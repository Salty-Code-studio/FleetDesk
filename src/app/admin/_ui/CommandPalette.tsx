"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useOverlay } from "./useOverlay";

interface Command {
  id: string;
  label: string;
  hint: string;
  /** Keywords broaden the fuzzy match without cluttering the label. */
  keywords?: string;
  run: () => void;
}

/**
 * Custom event other admin screens dispatch to register a contextual action,
 * e.g. Fleet broadcasts "Add vehicle" while it is mounted. The palette is the
 * single keyboard surface; pages opt in without importing it.
 */
const ACTION_EVENT = "fd:palette-action";

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

/**
 * Programmatic open, for a topbar button or another shortcut. Dispatches a
 * window event the mounted palette listens for.
 */
export function openCommandPalette() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("fd:palette-open"));
  }
}

/**
 * Register a contextual palette action for as long as the caller is mounted.
 * Returns a cleanup that removes it. Safe to call from any client component.
 */
export function registerPaletteAction(action: PaletteAction): () => void {
  if (typeof window === "undefined") return () => {};
  window.dispatchEvent(
    new CustomEvent(ACTION_EVENT, { detail: { type: "add", action } }),
  );
  return () => {
    window.dispatchEvent(
      new CustomEvent(ACTION_EVENT, { detail: { type: "remove", id: action.id } }),
    );
  };
}

const NAV: Array<{ label: string; hint: string; href: string; keywords?: string }> = [
  { label: "Dashboard", hint: "Overview", href: "/admin", keywords: "home start" },
  { label: "Reports", hint: "Revenue and utilization", href: "/admin/reports", keywords: "analytics revenue stats" },
  { label: "Fleet & pricing", hint: "Vehicles and rates", href: "/admin/fleet", keywords: "cars vehicles rates pricing" },
  { label: "Add-ons & insurance", hint: "Catalog", href: "/admin/catalog", keywords: "extras coverage" },
  { label: "Settings", hint: "Operator configuration", href: "/admin/settings", keywords: "config preferences" },
  { label: "Policies", hint: "Terms and rules", href: "/admin/policies", keywords: "terms rules legal" },
  { label: "Audit log", hint: "Activity history", href: "/admin/audit", keywords: "history changes" },
];

/**
 * Cmd/Ctrl+K command palette: searchable navigation plus contextual actions
 * (e.g. "Add vehicle" on the Fleet screen). Keyboard-first (Up/Down to move,
 * Enter to run, Escape to close), a11y via combobox + listbox roles and
 * aria-activedescendant. No external deps. Mounted once by AdminChrome.
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [actions, setActions] = useState<PaletteAction[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { panelRef } = useOverlay(open, () => setOpen(false));
  const listId = useId();

  const close = useCallback(() => setOpen(false), []);

  // Build the command set: nav jumps + any registered contextual actions.
  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = NAV.map((n) => ({
      id: `nav:${n.href}`,
      label: n.label,
      hint: n.hint,
      keywords: n.keywords,
      run: () => router.push(n.href),
    }));
    const acts: Command[] = actions.map((a) => ({
      id: `act:${a.id}`,
      label: a.label,
      hint: a.hint ?? "Action",
      keywords: a.keywords,
      run: a.run,
    }));
    return [...acts, ...nav];
  }, [router, actions]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) =>
      `${c.label} ${c.hint} ${c.keywords ?? ""}`.toLowerCase().includes(q),
    );
  }, [commands, query]);

  // Global Cmd/Ctrl+K toggles; programmatic open event also toggles on.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("fd:palette-open", onOpen as EventListener);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("fd:palette-open", onOpen as EventListener);
    };
  }, []);

  // Track contextual actions registered by other screens.
  useEffect(() => {
    function onAction(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { type: "add"; action: PaletteAction }
        | { type: "remove"; id: string };
      if (detail.type === "add") {
        setActions((list) => [
          ...list.filter((a) => a.id !== detail.action.id),
          detail.action,
        ]);
      } else {
        setActions((list) => list.filter((a) => a.id !== detail.id));
      }
    }
    window.addEventListener(ACTION_EVENT, onAction as EventListener);
    return () => window.removeEventListener(ACTION_EVENT, onAction as EventListener);
  }, []);

  // Reset query/cursor on open, focus the input.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      const raf = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
  }, [open]);

  // Keep the cursor in range as results shrink while typing.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, results.length - 1)));
  }, [results.length]);

  const runAt = useCallback(
    (index: number) => {
      const cmd = results[index];
      if (!cmd) return;
      close();
      cmd.run();
    },
    [results, close],
  );

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (results.length ? (a + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (results.length ? (a - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(active);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, results.length - 1));
    }
  }

  if (!open) return null;

  return (
    <div
      className="ui-overlay ui-overlay--palette is-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        className="ui-palette is-in"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="ui-palette__search">
          <span className="ui-palette__icon" aria-hidden="true">
            ~&lt;
          </span>
          <input
            ref={inputRef}
            className="ui-palette__input"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search actions and sections"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              results[active] ? `${listId}-${active}` : undefined
            }
            data-autofocus
          />
          <kbd className="ui-palette__kbd">Esc</kbd>
        </div>
        <ul className="ui-palette__list" id={listId} role="listbox">
          {results.length === 0 ? (
            <li
              className="ui-palette__empty"
              role="option"
              aria-selected={false}
              aria-disabled="true"
            >
              No matches
            </li>
          ) : (
            results.map((c, i) => (
              <li
                key={c.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`ui-palette__item${i === active ? " is-active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  runAt(i);
                }}
              >
                <span className="ui-palette__label">{c.label}</span>
                <span className="ui-palette__hint">{c.hint}</span>
              </li>
            ))
          )}
        </ul>
        <div className="ui-palette__foot" aria-hidden="true">
          <span><kbd>&uarr;</kbd><kbd>&darr;</kbd> Move</span>
          <span><kbd>&crarr;</kbd> Open</span>
          <span><kbd>Esc</kbd> Close</span>
        </div>
      </div>
    </div>
  );
}
