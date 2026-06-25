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
import "./select.css";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  /** Selected option value, or "" for none. Drop-in for <select value>. */
  value: string;
  /** Fires with the chosen option's value. Mirrors e.target.value. */
  onChange: (value: string) => void;
  /** The choices. Replaces native <option> children. */
  options: SelectOption[];
  /** Maps to the form control id (for <label htmlFor>). */
  id?: string;
  /** Advisory required flag; sets aria-required on the trigger. */
  required?: boolean;
  /** Accessible label when there is no visible <label>. */
  ariaLabel?: string;
  /** Trigger text shown when value === "". Default "Select...". */
  placeholder?: string;
  /** Disables the control, like select disabled. */
  disabled?: boolean;
  /** Maps to the select name attribute (kept for form-shape parity). */
  name?: string;
}

export function Select({
  value,
  onChange,
  options,
  id,
  required,
  ariaLabel,
  placeholder = "Select...",
  disabled = false,
  name,
}: SelectProps) {
  const reactId = useId();
  const listId = `${reactId}-list`;
  const optionId = (i: number) => `${reactId}-opt-${i}`;

  const [open, setOpen] = useState(false);
  // Index of the active (highlighted) option for keyboard nav.
  const [activeIndex, setActiveIndex] = useState(-1);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Buffer + timer for printable-character type-ahead.
  const typeBuffer = useRef("");
  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedIndex = useMemo(
    () => options.findIndex((o) => o.value === value),
    [options, value],
  );
  const selectedOption =
    selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const firstEnabledIndex = useCallback((): number => {
    return options.findIndex((o) => !o.disabled);
  }, [options]);

  const openList = useCallback(() => {
    if (disabled) return;
    const start =
      selectedIndex >= 0 && !options[selectedIndex]?.disabled
        ? selectedIndex
        : firstEnabledIndex();
    setActiveIndex(start);
    setOpen(true);
  }, [disabled, selectedIndex, options, firstEnabledIndex]);

  const closeList = useCallback(
    (returnFocus = true) => {
      setOpen(false);
      setActiveIndex(-1);
      if (returnFocus) {
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    },
    [],
  );

  const selectIndex = useCallback(
    (i: number) => {
      const opt = options[i];
      if (!opt || opt.disabled) return;
      onChange(opt.value);
      closeList();
    },
    [options, onChange, closeList],
  );

  // Step to the next/previous enabled option, wrapping is not applied (clamps).
  const stepActive = useCallback(
    (dir: 1 | -1) => {
      setActiveIndex((cur) => {
        let i = cur;
        for (let n = 0; n < options.length; n += 1) {
          i += dir;
          if (i < 0) i = 0;
          if (i > options.length - 1) i = options.length - 1;
          if (!options[i]?.disabled) return i;
          if ((dir === 1 && i === options.length - 1) || (dir === -1 && i === 0)) {
            // Hit the edge on a disabled option: stay where we were.
            return cur;
          }
        }
        return cur;
      });
    },
    [options],
  );

  const edgeActive = useCallback(
    (which: "first" | "last") => {
      if (which === "first") {
        setActiveIndex(firstEnabledIndex());
      } else {
        for (let i = options.length - 1; i >= 0; i -= 1) {
          if (!options[i]?.disabled) {
            setActiveIndex(i);
            return;
          }
        }
      }
    },
    [options, firstEnabledIndex],
  );

  const typeAhead = useCallback(
    (char: string) => {
      typeBuffer.current += char.toLowerCase();
      if (typeTimer.current) clearTimeout(typeTimer.current);
      typeTimer.current = setTimeout(() => {
        typeBuffer.current = "";
      }, 600);
      const buf = typeBuffer.current;
      const match = options.findIndex(
        (o) => !o.disabled && o.label.toLowerCase().startsWith(buf),
      );
      if (match >= 0) {
        if (open) {
          setActiveIndex(match);
        } else {
          // Closed: type-ahead selects directly, like a native <select>.
          onChange(options[match]!.value);
        }
      }
    },
    [options, open, onChange],
  );

  const onTriggerKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!open) {
        if (
          e.key === "ArrowDown" ||
          e.key === "ArrowUp" ||
          e.key === "Enter" ||
          e.key === " "
        ) {
          e.preventDefault();
          openList();
          return;
        }
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          typeAhead(e.key);
        }
        return;
      }
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          stepActive(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          stepActive(-1);
          break;
        case "Home":
          e.preventDefault();
          edgeActive("first");
          break;
        case "End":
          e.preventDefault();
          edgeActive("last");
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          if (activeIndex >= 0) selectIndex(activeIndex);
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          closeList();
          break;
        case "Tab":
          // Let focus leave; close without stealing focus back.
          closeList(false);
          break;
        default:
          if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            typeAhead(e.key);
          }
          break;
      }
    },
    [
      open,
      openList,
      stepActive,
      edgeActive,
      activeIndex,
      selectIndex,
      closeList,
      typeAhead,
    ],
  );

  // Click-outside closes (no focus return).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node | null;
      if (
        t &&
        !listRef.current?.contains(t) &&
        !triggerRef.current?.contains(t)
      ) {
        setOpen(false);
        setActiveIndex(-1);
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `#${CSS.escape(optionId(activeIndex))}`,
    );
    el?.scrollIntoView({ block: "nearest" });
    // optionId is stable for a given reactId; safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex]);

  useEffect(
    () => () => {
      if (typeTimer.current) clearTimeout(typeTimer.current);
    },
    [],
  );

  const triggerLabel = selectedOption ? selectedOption.label : placeholder;

  return (
    <div className="scds-sel">
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className={`scds-sel__trigger${selectedOption ? "" : " scds-sel__trigger--empty"}`}
        onClick={() => (open ? closeList() : openList())}
        onKeyDown={onTriggerKeyDown}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && activeIndex >= 0 ? optionId(activeIndex) : undefined
        }
        aria-label={ariaLabel}
        aria-required={required || undefined}
        data-name={name}
      >
        <span className="scds-sel__value">{triggerLabel}</span>
        <span className="scds-sel__chevron" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" focusable="false">
            <path
              d="M6 9l6 6 6-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {open ? (
        <div
          ref={listRef}
          id={listId}
          className="scds-sel__listbox"
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            const isActive = i === activeIndex;
            const classes = [
              "scds-sel__option",
              isSelected ? "scds-sel__option--selected" : "",
              isActive ? "scds-sel__option--active" : "",
              opt.disabled ? "scds-sel__option--disabled" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={`${opt.value}-${i}`}
                id={optionId(i)}
                role="option"
                aria-selected={isSelected}
                aria-disabled={opt.disabled || undefined}
                className={classes}
                onMouseEnter={() => {
                  if (!opt.disabled) setActiveIndex(i);
                }}
                onMouseDown={(e) => {
                  // Prevent the trigger losing focus before we handle the click.
                  e.preventDefault();
                }}
                onClick={() => selectIndex(i)}
              >
                <span className="scds-sel__check" aria-hidden="true">
                  {isSelected ? (
                    <svg
                      viewBox="0 0 24 24"
                      width="14"
                      height="14"
                      focusable="false"
                    >
                      <path
                        d="M5 13l4 4L19 7"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </span>
                <span className="scds-sel__label">{opt.label}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export default Select;
