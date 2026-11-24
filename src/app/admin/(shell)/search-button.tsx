"use client";

import { openCommandPalette } from "../_ui";

/** Topbar search box. Opens the palette, which finds customers, rentals and
 *  sections. A real tap target for the iPad, where Cmd+K does not exist. */
export function SearchButton() {
  return (
    <button type="button" className="topbar-search" onClick={openCommandPalette} aria-label="Search customers and rentals">
      <span className="topbar-search__text">Search customers, phone, plate</span>
      <kbd>⌘K</kbd>
    </button>
  );
}
