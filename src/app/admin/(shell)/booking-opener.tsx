"use client";

import { useEffect, useState } from "react";
import { OPEN_BOOKING_EVENT } from "../_ui";
import { BookingDrawer } from "./booking-drawer";

/** Fired after a write in the search-opened sheet. The Board listens (Today
 *  already refreshes on every ADMIN_MUTATED). */
export const SHEET_CHANGED_EVENT = "fd:sheet-changed";

/**
 * One booking sheet for the whole shell, opened by a search result on any
 * page.
 */
export function BookingOpener() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const next = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (next) setId(next);
    };
    window.addEventListener(OPEN_BOOKING_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_BOOKING_EVENT, onOpen);
  }, []);
  return <BookingDrawer bookingId={id} onClose={() => setId(null)} onChanged={() => window.dispatchEvent(new Event(SHEET_CHANGED_EVENT))} />;
}
