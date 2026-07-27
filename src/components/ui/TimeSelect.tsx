"use client";

import "./time-select.css";

export interface TimeSelectProps {
  /** "HH:MM" or "" for empty. */
  value: string;
  /** Fires with the "HH:MM" string picked. */
  onChange: (v: string) => void;
  /** "HH:MM" lower bound (inclusive). Default "00:00". */
  min?: string;
  /** "HH:MM" upper bound (inclusive). Default "23:30". */
  max?: string;
  /** Minute step between options. Default 30. */
  stepMinutes?: number;
  /** Maps to the select id (for <label htmlFor>). */
  id?: string;
  /** Accessible label when there is no visible <label>. */
  ariaLabel?: string;
  /** Disables the control, like select disabled. */
  disabled?: boolean;
}

/** Build the "HH:MM" option list from min to max (inclusive) at `step` minutes. */
function options(min: string, max: string, step: number): string[] {
  const out: string[] = [];
  const [h0, m0] = min.split(":").map(Number);
  const [h1, m1] = max.split(":").map(Number);
  for (let t = h0! * 60 + m0!; t <= h1! * 60 + m1!; t += step) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
  }
  return out;
}

export function TimeSelect({
  value,
  onChange,
  min = "00:00",
  max = "23:30",
  stepMinutes = 30,
  id,
  ariaLabel,
  disabled,
}: TimeSelectProps) {
  return (
    <select
      className="time-select"
      id={id}
      aria-label={ariaLabel}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="" disabled>Select a time</option>
      {options(min, max, stepMinutes).map((t) => <option key={t} value={t}>{t}</option>)}
    </select>
  );
}

export default TimeSelect;
