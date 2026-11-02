// src/app/admin/(shell)/page.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiGet, ADMIN_MUTATED, type ApiError } from "../client";
import { Skeleton, EmptyState, useToast } from "@/app/admin/_ui";
import type { TodayBoard, TodayItem } from "@/lib/admin/today";
import { BookingDrawer } from "./booking-drawer";
import { SetupHook } from "./setup-checklist";
import "./fleet/fleet.css";
import "./today.css";

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function longDate(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

/** The hero sentence. One huge number, then the rest tiny. */
function headline(b: TodayBoard): { big: string; line: string; tail: string } {
  if (b.total === 0) return { big: "Clear", line: "Nothing needs you today.", tail: longDate(b.day) };
  const open = b.total - b.done;
  if (open === 0) return { big: "Done", line: "Everything for today is handled.", tail: longDate(b.day) };
  const big = String(b.goingOut || b.comingBack || b.total);
  const line = b.goingOut
    ? `${b.goingOut === 1 ? "goes" : "go"} out today`
    : b.comingBack
      ? `${b.comingBack === 1 ? "comes" : "come"} back today`
      : `${b.total === 1 ? "needs" : "need"} you today`;
  const parts: string[] = [];
  if (b.goingOut && b.comingBack) parts.push(`${b.comingBack} ${b.comingBack === 1 ? "return" : "returns"}`);
  if (b.unpaid) parts.push(`${b.unpaid} unpaid`);
  const tail = [longDate(b.day), ...parts].join(". ");
  return { big, line, tail };
}

/** The one signal button: the first open item's action. Staff cannot open the booking sheet, so they get the first open item with a wizard link. */
function firstOpen(b: TodayBoard, staff: boolean): TodayItem | undefined {
  return b.items.find((i) => !i.done && (!staff || i.href));
}

type TodayView = TodayBoard & { viewerRole: "owner" | "staff" };

const KIND_LABEL: Record<TodayItem["kind"], string> = {
  overdue: "Overdue", return: "Coming back", handover: "Going out", unpaid: "Unpaid",
};
/** "Unpaid: $175.00 still due" → "$175.00"; falls back to the whole note. */
const owed = (note: string) => note.match(/\$[\d,.]+/)?.[0] ?? note;
type FilterId = "all" | "out" | "back" | "unpaid" | "done";
const FILTERS: { id: FilterId; label: string; match: (i: TodayItem) => boolean }[] = [
  { id: "all", label: "All", match: () => true },
  { id: "out", label: "Going out", match: (i) => i.kind === "handover" && !i.done },
  { id: "back", label: "Coming back", match: (i) => (i.kind === "return" || i.kind === "overdue") && !i.done },
  { id: "unpaid", label: "Unpaid", match: (i) => i.kind === "unpaid" && !i.done },
  { id: "done", label: "Done", match: (i) => i.done },
];

export default function TodayPage() {
  const [board, setBoard] = useState<TodayView | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterId>("all");
  const toast = useToast();

  // Refreshes can overlap (focus plus a write); only the latest may land, and
  // nothing lands after unmount.
  const seq = useRef(0);
  useEffect(() => () => { seq.current = -1; }, []);

  /** quiet = a background refresh: no toast, the stale note says it instead. */
  const load = useCallback(async (quiet = false) => {
    const mine = ++seq.current;
    try {
      const next = await apiGet<TodayView>("/api/admin/today");
      if (mine !== seq.current) return;
      setBoard(next);
      setFailed(false);
    } catch (e) {
      if (mine !== seq.current) return;
      setFailed(true);
      if (!quiet) toast.show({ type: "error", message: (e as ApiError).message });
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  // The desk leaves this tab open all day: refresh when it comes back into
  // view and after any write (a handover finished in the sheet, say).
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load(true); };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener(ADMIN_MUTATED, refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(ADMIN_MUTATED, refresh);
    };
  }, [load]);

  if (loading) {
    return (
      <div className="td">
        <div className="td-hero td-hero--skel"><Skeleton height={56} width="40%" /><Skeleton height={18} width="60%" /></div>
        <div className="td-grid"><Skeleton height={190} /><Skeleton height={190} /><Skeleton height={190} /></div>
      </div>
    );
  }

  if (!board && failed) {
    return (
      <div className="td">
        <EmptyState
          title="Today did not load"
          hint="Check the connection and try again."
          action={<button type="button" className="btn btn--accent" onClick={() => { setLoading(true); void load(); }}>Try again</button>}
        />
      </div>
    );
  }

  if (!board) return null;

  const staff = board.viewerRole === "staff";
  const h = headline(board);
  const next = firstOpen(board, staff);
  const pct = board.total === 0 ? 0 : Math.round((board.done / board.total) * 100);

  return (
    <div className="td">
      <section className="td-hero" aria-label="Today">
        <span className="td-hero__back" aria-hidden="true">{h.big}</span>
        <div className="td-hero__mid">
          <h1 className="td-hero__big">{h.big}<span className="td-hero__line"> {h.line}</span></h1>
          <p className="td-hero__tail">{h.tail}</p>
        </div>
        {failed && (
          <p className="td-stale" role="status">
            Could not refresh. This is the last list we had.{" "}
            <button type="button" className="btn btn--quiet" onClick={() => void load()}>Try again</button>
          </p>
        )}
        <div className="td-hero__top">
          {next && (next.href
            ? <Link className="btn btn--accent td-cta" href={next.href}>{next.action}</Link>
            : <button type="button" className="btn btn--accent td-cta" onClick={() => setSheetId(next.bookingId)}>{next.action}</button>)}
          <Link className="btn td-cta" href="/admin/board">Open board</Link>
        </div>
      </section>

      {board.total > 0 && (
        <div className="td-progress" role="progressbar" aria-valuemin={0} aria-valuemax={board.total} aria-valuenow={board.done} aria-label="Handled today">
          <i style={{ width: `${pct}%` }} />
          <span className="td-progress__label">{board.done} of {board.total} done</span>
        </div>
      )}

      {!staff && <SetupHook />}

      {board.total === 0 ? (
        <EmptyState
          mark="~<"
          title="A clear desk"
          hint="No handovers, returns or open balances today. The board shows what is coming."
          action={<Link className="btn btn--accent" href="/admin/board">Open the board</Link>}
        />
      ) : (
        <div className="panel td-panel">
          <div className="td-filters" role="group" aria-label="Show">
            {FILTERS.filter((f) => f.id === "all" || board.items.some(f.match)).map((f) => (
              <button key={f.id} type="button" className={`fleet-chip ${filter === f.id ? "is-on" : ""}`} onClick={() => setFilter(f.id)}>
                {f.label} <span className="td-filters__n">{board.items.filter(f.match).length}</span>
              </button>
            ))}
          </div>
          <ol className="td-grid">
            {board.items.filter((FILTERS.find((f) => f.id === filter) ?? FILTERS[0]!).match).sort((a, b) => Number(a.done) - Number(b.done)).map((it) => (
              <li key={it.bookingId} className={`td-card td-card--${it.kind}${it.done ? " is-done" : ""}`}>
                {!staff && (
                  <button type="button" className="td-card__open" aria-label={`Open ${it.customer}`} onClick={() => setSheetId(it.bookingId)} />
                )}
                <div className="td-card__top">
                  <span className="td-card__kind">{it.done ? `Done · ${KIND_LABEL[it.kind]}` : KIND_LABEL[it.kind]}</span>
                  <span className="td-card__time">{it.kind === "unpaid" && it.note ? owed(it.note) : it.time}</span>
                </div>
                <div className="td-card__body">
                  <span className="td-card__name">{it.customer}</span>
                  <span className="td-card__car">{it.plate} · {it.vehicle}</span>
                  {it.unpaid && it.note && it.kind !== "unpaid" && <span className="td-card__note">{it.note.replace(/^Unpaid:\s*/, "")}</span>}
                  {it.kind === "unpaid" && <span className="td-card__note">Still owed</span>}
                  <div className="td-card__foot">
                    {it.done
                      ? <span className="td-card__done">{it.action}</span>
                      : it.href
                        ? <Link className="td-card__do" href={it.href}>{it.action}</Link>
                        : staff
                          ? <span className="td-card__owner">{it.action}</span>
                          : <button type="button" className="td-card__do" onClick={() => setSheetId(it.bookingId)}>{it.action}</button>}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      <BookingDrawer bookingId={sheetId} onClose={() => setSheetId(null)} onChanged={() => { void load(); }} />
    </div>
  );
}
