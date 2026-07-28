"use client";

import { useEffect, useRef, useState, type ChangeEvent as ReactChangeEvent } from "react";

/**
 * Parses a user-typed dollar-amount string into integer cents, tolerating
 * the interim states a person passes through while typing a decimal value
 * character-by-character -- e.g. "4" -> "45" -> "45." -> "45.5" -> "45.50".
 *
 * Returns null when the string isn't (yet) a committable amount (empty, or
 * containing anything but digits and a single dot). Callers should keep the
 * previously-committed cents value in that case rather than zeroing it --
 * that's the bug this type exists to prevent: an `<input type="number">`'s
 * `.value` reads "" for an interim string like "45." (it's not a valid
 * floating-point number per the HTML number-input parsing rules), so naively
 * doing `Math.round(Number(e.target.value) * 100)` on every keystroke
 * collapses the field to 0 the instant a decimal point is typed.
 */
export function parseDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "" || !/^\d*\.?\d*$/.test(trimmed)) return null;
  // A bare "." (or nothing but "") has no digits at all -- not committable.
  if (!/\d/.test(trimmed)) return null;
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100);
}

/** Formats integer cents as a plain dollars string, e.g. 4550 -> "45.5". */
export function centsToDollarsString(cents: number): string {
  return (cents / 100).toString();
}

export interface MoneyInputProps {
  /** Current committed value, in integer cents. */
  cents: number;
  /**
   * Fires with the newly committed integer-cents value. Only fires for a
   * parseable amount -- an interim "45." keeps the last committed value
   * until the string resolves to a real number, so the field never resets
   * to 0 mid-type.
   */
  onChange: (cents: number) => void;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
}

/**
 * A dollars-formatted money input. Keeps the raw typed string in local
 * state (a plain text input, not `type="number"`) and only commits an
 * integer-cents value to the caller on a valid parse, so typing a decimal
 * point character-by-character (e.g. "45.50") never collapses the
 * persisted value to 0. See MoneyInput.test.ts for the exact repro this
 * guards against.
 */
export function MoneyInput({
  cents,
  onChange,
  id,
  ariaLabel,
  disabled,
  required,
  placeholder,
}: MoneyInputProps) {
  const [raw, setRaw] = useState(() => centsToDollarsString(cents));
  const isFocused = useRef(false);

  // Reflect external updates (e.g. the settings payload reloading after
  // save) unless the user is actively typing -- otherwise this would stomp
  // an interim value like "45." back to "45" mid-keystroke.
  useEffect(() => {
    if (!isFocused.current) setRaw(centsToDollarsString(cents));
  }, [cents]);

  function handleChange(e: ReactChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    setRaw(next);
    const parsed = parseDollarsToCents(next);
    if (parsed !== null) onChange(parsed);
  }

  function handleBlur() {
    isFocused.current = false;
    const parsed = parseDollarsToCents(raw);
    const committed = parsed ?? cents;
    setRaw(centsToDollarsString(committed));
    if (parsed !== null && parsed !== cents) onChange(parsed);
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      id={id}
      aria-label={ariaLabel}
      disabled={disabled}
      required={required}
      placeholder={placeholder}
      value={raw}
      onFocus={() => {
        isFocused.current = true;
      }}
      onChange={handleChange}
      onBlur={handleBlur}
    />
  );
}

export default MoneyInput;
