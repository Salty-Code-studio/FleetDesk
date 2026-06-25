"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import "./date-picker.css";

export interface DatePickerProps {
  /** ISO "yyyy-mm-dd" or "" for empty. Drop-in for <input type="date" value>. */
  value: string;
  /** Fires with the ISO "yyyy-mm-dd" string, or "" when cleared. */
  onChange: (iso: string) => void;
  /** ISO "yyyy-mm-dd" lower bound (inclusive). Like input min. */
  min?: string;
  /** ISO "yyyy-mm-dd" upper bound (inclusive). Like input max. */
  max?: string;
  /** Maps to the form control id (for <label htmlFor>). */
  id?: string;
  /** Maps to the input required attribute (advisory; trigger marks aria-required). */
  required?: boolean;
  /** Accessible label when there is no visible <label>. */
  ariaLabel?: string;
  /** Text shown on the trigger when value is "". Default "Select a date". */
  placeholder?: string;
  /** Disables the control, like input disabled. */
  disabled?: boolean;
  /** Maps to the input name attribute (kept for form-shape parity). */
  name?: string;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Parse "yyyy-mm-dd" into a local Date, or null when invalid/empty. */
function parseISO(iso: string): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, mo - 1, d);
  // Reject overflow (e.g. 2026-02-31 -> Mar 3).
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== mo - 1 ||
    date.getDate() !== d
  ) {
    return null;
  }
  return date;
}

/** Serialize a Date to "yyyy-mm-dd" using local fields (no UTC shift). */
function toISO(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, "0");
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/** "24 Jun 2026" */
function formatDisplay(date: Date): string {
  return `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]} ${date.getFullYear()}`;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

/** Shift a date by whole months, keeping the day-of-month (clamped to the target month's length). */
function addMonthsKeepDay(date: Date, months: number): Date {
  const y = date.getFullYear();
  const targetMonth = date.getMonth() + months;
  const lastDay = new Date(y, targetMonth + 1, 0).getDate();
  const day = Math.min(date.getDate(), lastDay);
  return new Date(y, targetMonth, day);
}

/** Mon=0..Sun=6 weekday index for a date. */
function isoWeekday(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/** The 42 days (6 weeks) for the grid of the month containing `month`. */
function buildGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const lead = isoWeekday(first);
  const gridStart = addDays(first, -lead);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i += 1) cells.push(addDays(gridStart, i));
  return cells;
}

export function DatePicker({
  value,
  onChange,
  min,
  max,
  id,
  required,
  ariaLabel,
  placeholder = "Select a date",
  disabled = false,
  name,
}: DatePickerProps) {
  const reactId = useId();
  const dialogId = `${reactId}-dialog`;
  const monthLabelId = `${reactId}-month`;
  const gridId = `${reactId}-grid`;

  const selected = useMemo(() => parseISO(value), [value]);
  const minDate = useMemo(() => parseISO(min ?? ""), [min]);
  const maxDate = useMemo(() => parseISO(max ?? ""), [max]);
  const today = useMemo(() => startOfDay(new Date()), []);

  const [open, setOpen] = useState(false);
  // Month currently shown in the grid (first day of that month).
  const [viewMonth, setViewMonth] = useState<Date>(
    () => selected ?? today,
  );
  // The day cell that is roving-tabindex focusable / aria-activedescendant.
  const [focusDate, setFocusDate] = useState<Date>(
    () => selected ?? today,
  );

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  // When true, the active grid cell should receive DOM focus after render.
  const pendingFocus = useRef(false);

  const isDisabledDate = useCallback(
    (date: Date): boolean => {
      const d = startOfDay(date);
      if (minDate && d.getTime() < startOfDay(minDate).getTime()) return true;
      if (maxDate && d.getTime() > startOfDay(maxDate).getTime()) return true;
      return false;
    },
    [minDate, maxDate],
  );

  // Sync the view + focus to the selected value whenever it changes externally.
  useEffect(() => {
    if (selected) {
      setViewMonth(new Date(selected.getFullYear(), selected.getMonth(), 1));
      setFocusDate(selected);
    }
  }, [selected]);

  const openCalendar = useCallback(() => {
    if (disabled) return;
    const base = selected ?? today;
    setViewMonth(new Date(base.getFullYear(), base.getMonth(), 1));
    setFocusDate(base);
    pendingFocus.current = true;
    setOpen(true);
  }, [disabled, selected, today]);

  const closeCalendar = useCallback(
    (returnFocus = true) => {
      setOpen(false);
      if (returnFocus) {
        // Restore focus to the trigger after the popover unmounts.
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    },
    [],
  );

  // Click-outside closes (no focus return; user is interacting elsewhere).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node | null;
      if (
        t &&
        !popoverRef.current?.contains(t) &&
        !triggerRef.current?.contains(t)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  // Move DOM focus onto the active day cell when the grid opens or focus moves.
  useEffect(() => {
    if (!open || !pendingFocus.current) return;
    pendingFocus.current = false;
    const cell = gridRef.current?.querySelector<HTMLElement>(
      '[data-active="true"]',
    );
    cell?.focus();
  }, [open, focusDate, viewMonth]);

  const commit = useCallback(
    (date: Date) => {
      if (isDisabledDate(date)) return;
      onChange(toISO(date));
      closeCalendar();
    },
    [isDisabledDate, onChange, closeCalendar],
  );

  const moveFocus = useCallback(
    (next: Date) => {
      // Follow into a new month if the move crosses the boundary.
      if (
        next.getMonth() !== viewMonth.getMonth() ||
        next.getFullYear() !== viewMonth.getFullYear()
      ) {
        setViewMonth(new Date(next.getFullYear(), next.getMonth(), 1));
      }
      setFocusDate(next);
      pendingFocus.current = true;
    },
    [viewMonth],
  );

  const onGridKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          moveFocus(addDays(focusDate, -1));
          break;
        case "ArrowRight":
          e.preventDefault();
          moveFocus(addDays(focusDate, 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          moveFocus(addDays(focusDate, -7));
          break;
        case "ArrowDown":
          e.preventDefault();
          moveFocus(addDays(focusDate, 7));
          break;
        case "Home":
          e.preventDefault();
          moveFocus(addDays(focusDate, -isoWeekday(focusDate)));
          break;
        case "End":
          e.preventDefault();
          moveFocus(addDays(focusDate, 6 - isoWeekday(focusDate)));
          break;
        case "PageUp":
          e.preventDefault();
          moveFocus(addMonths(focusDate, -1));
          break;
        case "PageDown":
          e.preventDefault();
          moveFocus(addMonths(focusDate, 1));
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          commit(focusDate);
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          closeCalendar();
          break;
        default:
          break;
      }
    },
    [focusDate, moveFocus, commit, closeCalendar],
  );

  const cells = useMemo(() => buildGrid(viewMonth), [viewMonth]);
  const headerLabel = `${MONTHS[viewMonth.getMonth()]} ${viewMonth.getFullYear()}`;

  const triggerLabel = selected ? formatDisplay(selected) : placeholder;

  return (
    <div className="scds-dp">
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className={`scds-dp__trigger${selected ? "" : " scds-dp__trigger--empty"}`}
        onClick={() => (open ? closeCalendar() : openCalendar())}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-label={ariaLabel}
        data-required={required || undefined}
        data-name={name}
      >
        <span className="scds-dp__value">{triggerLabel}</span>
        <span className="scds-dp__glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" focusable="false">
            <rect
              x="3"
              y="4.5"
              width="18"
              height="16"
              rx="2.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <path
              d="M3 9h18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <path
              d="M8 2.5v4M16 2.5v4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </span>
      </button>

      {open ? (
        <div
          ref={popoverRef}
          id={dialogId}
          className="scds-dp__popover"
          role="dialog"
          aria-modal="false"
          aria-labelledby={monthLabelId}
        >
          <div className="scds-dp__head">
            <button
              type="button"
              className="scds-dp__nav"
              onClick={() => {
                setViewMonth(addMonths(viewMonth, -1));
                setFocusDate(addMonthsKeepDay(focusDate, -1));
                pendingFocus.current = true;
              }}
              aria-label="Previous month"
            >
              <span aria-hidden="true">&#8249;</span>
            </button>
            <div className="scds-dp__title" id={monthLabelId} aria-live="polite">
              {headerLabel}
            </div>
            <button
              type="button"
              className="scds-dp__nav"
              onClick={() => {
                setViewMonth(addMonths(viewMonth, 1));
                setFocusDate(addMonthsKeepDay(focusDate, 1));
                pendingFocus.current = true;
              }}
              aria-label="Next month"
            >
              <span aria-hidden="true">&#8250;</span>
            </button>
          </div>

          <div className="scds-dp__weekdays" aria-hidden="true">
            {WEEKDAYS.map((w) => (
              <span key={w} className="scds-dp__weekday">
                {w}
              </span>
            ))}
          </div>

          <div
            ref={gridRef}
            id={gridId}
            className="scds-dp__grid"
            role="grid"
            aria-labelledby={monthLabelId}
            onKeyDown={onGridKeyDown}
          >
            {cells.map((date) => {
              const outside = date.getMonth() !== viewMonth.getMonth();
              const isSelected = selected ? sameDay(date, selected) : false;
              const isToday = sameDay(date, today);
              const isActive = sameDay(date, focusDate);
              const dis = isDisabledDate(date);
              const classes = [
                "scds-dp__day",
                outside ? "scds-dp__day--outside" : "",
                isSelected ? "scds-dp__day--selected" : "",
                isToday ? "scds-dp__day--today" : "",
                dis ? "scds-dp__day--disabled" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  key={toISO(date)}
                  type="button"
                  role="gridcell"
                  className={classes}
                  data-active={isActive ? "true" : undefined}
                  tabIndex={isActive ? 0 : -1}
                  aria-selected={isSelected}
                  aria-current={isToday ? "date" : undefined}
                  aria-disabled={dis || undefined}
                  aria-label={`${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`}
                  onClick={() => (dis ? undefined : commit(date))}
                >
                  <span className="scds-dp__daynum">{date.getDate()}</span>
                </button>
              );
            })}
          </div>

          <div className="scds-dp__actions">
            <button
              type="button"
              className="scds-dp__action"
              onClick={() => {
                if (isDisabledDate(today)) return;
                onChange(toISO(today));
                closeCalendar();
              }}
              disabled={isDisabledDate(today)}
            >
              Today
            </button>
            <button
              type="button"
              className="scds-dp__action scds-dp__action--ghost"
              onClick={() => {
                onChange("");
                closeCalendar();
              }}
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default DatePicker;
