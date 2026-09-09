/**
 * Is there money outstanding on this rental, and why?
 *
 * Two mechanisms feed one answer, deliberately kept side by side:
 *
 *   - "Betaald t/m" (paidUntil) — a coverage marker the desk maintains on
 *     rolling monthly rentals. It touches no money; it says which day the
 *     renter has paid through. When it is set, it decides.
 *   - The balance — snapshot subtotal minus everything actually settled.
 *     Used for ordinary day rentals, and whenever no marker is set.
 *
 * Only a rental that has actually gone out can be "unpaid" on the board:
 * picked_up (with the customer) or completed (back, but never settled). A
 * pending or confirmed booking is simply not owed yet, and a cancelled one is
 * not owed at all.
 *
 * This lives in its own module, with zero imports, so the rule is unit-testable
 * on its own. The Little John fork inlined it inside the planning query, and
 * that is exactly how a typo (`totalCents`, a key nothing ever writes) survived
 * in production long enough to keep the balance branch permanently dead.
 */

export interface PaidStateInput {
  status: string;
  paidUntil: string | null;
  subtotalCents: number;
  amountPaidCents: number;
  currency: string;
  /** Today in the operator's local timezone, YYYY-MM-DD. */
  todayLocal: string;
}

export interface PaidState {
  unpaid: boolean;
  balanceDueCents: number;
  /** One plain sentence for the board tooltip and the drawer, or null. */
  note: string | null;
}

const OUT_OR_DONE = new Set(["picked_up", "completed"]);

function money(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  return currency === "USD" ? `$${amount}` : `${currency} ${amount}`;
}

export function paidState(i: PaidStateInput): PaidState {
  const balanceDueCents = Math.max(0, i.subtotalCents - i.amountPaidCents);
  const live = OUT_OR_DONE.has(i.status);

  // "t/m" is inclusive: a marker of the 8th means the 8th is still covered.
  const unpaid = live && (i.paidUntil !== null
    ? i.paidUntil < i.todayLocal
    : balanceDueCents > 0);

  let note: string | null = null;
  if (unpaid && i.paidUntil !== null) note = `Unpaid: paid until ${i.paidUntil}`;
  else if (unpaid) note = `Unpaid: ${money(balanceDueCents, i.currency)} still due`;
  else if (i.paidUntil !== null) note = `Paid until ${i.paidUntil}`;

  return { unpaid, balanceDueCents, note };
}
