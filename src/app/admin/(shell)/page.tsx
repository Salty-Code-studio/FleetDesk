// src/app/admin/(shell)/page.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, type ApiError } from "../client";
import { Skeleton, EmptyState, useToast } from "@/app/admin/_ui";
import type { TodayBoard, TodayItem } from "@/lib/admin/today";
import { BookingDrawer } from "./booking-drawer";
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

/** The one signal button: the first open item's action. */
function firstOpen(b: TodayBoard): TodayItem | undefined {
  return b.items.find((i) => !i.done);
}

export default function TodayPage() {
  const [board, setBoard] = useState<TodayBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setBoard(await apiGet<TodayBoard>("/api/admin/today"));
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError).message });
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  if (loading || !board) {
    return (
      <div className="td">
        <div className="td-hero td-hero--skel"><Skeleton height={56} width="40%" /><Skeleton height={18} width="60%" /></div>
        <div className="td-queue"><Skeleton height={64} /><Skeleton height={64} /><Skeleton height={64} /></div>
      </div>
    );
  }

  const h = headline(board);
  const next = firstOpen(board);
  const pct = board.total === 0 ? 0 : Math.round((board.done / board.total) * 100);

  return (
    <div className="td">
      <section className="td-hero" aria-label="Today">
        <span className="td-hero__back" aria-hidden="true">{h.big}</span>
        <div className="td-hero__mid">
          <h1 className="td-hero__big">{h.big}<span className="td-hero__line"> {h.line}</span></h1>
          <p className="td-hero__tail">{h.tail}</p>
        </div>
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

      {board.total === 0 ? (
        <EmptyState
          mark="~<"
          title="A clear desk"
          hint="No handovers, returns or open balances today. The board shows what is coming."
          action={<Link className="btn btn--accent" href="/admin/board">Open the board</Link>}
        />
      ) : (
        <ol className="td-queue">
          {board.items.map((it) => (
            <li key={it.bookingId} className={`td-row td-row--${it.kind}${it.done ? " is-done" : ""}`}>
              <span className="td-row__time">{it.time}</span>
              <button type="button" className="td-row__who" onClick={() => setSheetId(it.bookingId)}>
                <b>{it.customer}</b>
                <span>{it.vehicle}, {it.plate}{it.kind === "overdue" ? ", overdue" : ""}{it.unpaid && it.note ? `, ${it.note.replace(/^Unpaid: /, "")}` : ""}</span>
              </button>
              {it.done
                ? <span className="td-row__done">{it.action}</span>
                : it.href
                  ? <Link className="td-row__do" href={it.href}>{it.action}</Link>
                  : <button type="button" className="td-row__do" onClick={() => setSheetId(it.bookingId)}>{it.action}</button>}
            </li>
          ))}
        </ol>
      )}

      <BookingDrawer bookingId={sheetId} onClose={() => setSheetId(null)} onChanged={() => { void load(); }} />
    </div>
  );
}
