"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useOverlay } from "./useOverlay";
import { apiGet } from "../client";
import type { SearchResult } from "@/lib/admin/search";

interface Command {
  id: string;
  label: string;
  hint: string;
  /** Heading shown above the first command of a group. */
  section?: string;
  /** Visual nesting: a rental listed under its customer. */
  nested?: boolean;
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

/** Window event that opens the booking sheet from anywhere in the shell.
 *  BookingOpener (mounted once in the shell layout) listens for it. */
export const OPEN_BOOKING_EVENT = "fd:open-booking";

export function openBooking(id: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OPEN_BOOKING_EVENT, { detail: { id } }));
  }
}

const SEARCH_MIN = 2;
const SEARCH_DEBOUNCE_MS = 180;

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
  { label: "Today", hint: "What needs you", href: "/admin", keywords: "home start dashboard handovers returns" },
  { label: "Board", hint: "Fleet planning", href: "/admin/board", keywords: "planning calendar timeline" },
  { label: "Fleet", hint: "Vehicles and rates", href: "/admin/fleet", keywords: "cars vehicles rates pricing" },
  { label: "Money", hint: "Revenue and deposits", href: "/admin/reports", keywords: "reports analytics revenue stats" },
  { label: "Setup", hint: "Operator configuration", href: "/admin/settings", keywords: "settings config preferences" },
  { label: "Add-ons & insurance", hint: "Setup", href: "/admin/catalog", keywords: "extras coverage catalog" },
  { label: "Policies", hint: "Setup", href: "/admin/policies", keywords: "terms rules legal" },
  { label: "Staff", hint: "Setup", href: "/admin/staff", keywords: "team codes" },
  { label: "Audit log", hint: "Setup", href: "/admin/audit", keywords: "history changes" },
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
  const [found, setFound] = useState<SearchResult["customers"]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
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

  // Customers and their rentals, fetched as the desk types.
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < SEARCH_MIN) {
      setFound([]);
      setSearching(false);
      setSearchFailed(false);
      return;
    }
    let live = true;
    setSearching(true);
    const t = setTimeout(() => {
      apiGet<SearchResult>(`/api/admin/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (!live) return;
          setFound(r.customers);
          setSearchFailed(false);
        })
        .catch(() => {
          if (!live) return;
          setFound([]);
          setSearchFailed(true);
        })
        .finally(() => {
          if (live) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    const people: Command[] = [];
    found.forEach((c, ci) => {
      const contact = c.phone || c.email;
      const first = c.bookings[0];
      people.push({
        id: `cust:${c.id}`,
        label: c.name || c.email,
        hint: `${contact}${c.rentals > 1 ? ` · ${c.rentals} rentals` : ""}`,
        section: ci === 0 ? "Customers and rentals" : undefined,
        run: () => { if (first) openBooking(first.id); },
      });
      for (const b of c.bookings) {
        people.push({
          id: `book:${b.id}`,
          label: b.dates,
          hint: `${b.plate} · ${b.statusLabel}`,
          nested: true,
          run: () => openBooking(b.id),
        });
      }
    });
    const nav = commands.filter((c) =>
      `${c.label} ${c.hint} ${c.keywords ?? ""}`.toLowerCase().includes(q),
    );
    if (people.length && nav.length) nav[0] = { ...nav[0]!, section: "Go to" };
    return [...people, ...nav];
  }, [commands, query, found]);

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
            placeholder="Search customers, phone, plate or section"
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
              {searching ? "Searching…" : searchFailed ? "Search did not load. Try again." : "No matches"}
            </li>
          ) : (
            results.flatMap((c, i) => [
              ...(c.section
                ? [
                    <li key={`h:${c.id}`} className="ui-palette__section" role="presentation">
                      {c.section}
                    </li>,
                  ]
                : []),
              <li
                key={c.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`ui-palette__item${c.nested ? " ui-palette__item--nested" : ""}${i === active ? " is-active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  runAt(i);
                }}
              >
                <span className="ui-palette__label">{c.label}</span>
                <span className="ui-palette__hint">{c.hint}</span>
              </li>,
            ])
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
