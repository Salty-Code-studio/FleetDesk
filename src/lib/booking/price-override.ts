/**
 * Owner price override on an existing booking.
 *
 * The owner sometimes settles a rental against something else, or corrects a
 * price after the fact. Whatever is typed becomes the revenue — reports read
 * subtotalCents and follow automatically.
 *
 * The override deliberately PRESERVES the original quote rather than replacing
 * it. The rental-contract PDF itemises the breakdown line by line (vehicle,
 * insurance, add-ons, young-driver fee), so flattening it to a bare amount
 * would print a contract whose lines do not add up to its total. Instead the
 * original lines stay, subtotalCents is rewritten, and a signed adjustmentCents
 * carries the difference as its own line.
 *
 * NOTE: zero imports, so the shape is unit-testable without a database.
 */

export interface PriceOverrideMeta {
  /** The subtotal the ORIGINAL quote produced, never the previous edit. */
  previousSubtotalCents: number;
  reason: string;
  byAdminId: string;
  /** ISO timestamp. */
  at: string;
}

/**
 * priceBreakdown is untyped jsonb and comes in two shapes — a full
 * QuoteBreakdown for online bookings, a flat {manual, subtotalCents, currency}
 * for desk-created ones — so everything here is optional and passthrough.
 */
export interface OverridableBreakdown {
  subtotalCents?: number;
  adjustmentCents?: number;
  priceOverride?: PriceOverrideMeta;
  [key: string]: unknown;
}

/** The quoted subtotal, looking through any override already applied. */
export function originalSubtotalCents(breakdown: OverridableBreakdown): number {
  return breakdown.priceOverride?.previousSubtotalCents ?? Number(breakdown.subtotalCents ?? 0);
}

export function applyPriceOverride(
  breakdown: OverridableBreakdown,
  newSubtotalCents: number,
  meta: { reason: string; byAdminId: string; at: string },
): OverridableBreakdown {
  // Anchor on the ORIGINAL quote so a second edit does not measure itself
  // against the first one; otherwise the adjustment line drifts and the
  // contract's line items stop summing to the total.
  const original = originalSubtotalCents(breakdown);
  return {
    ...breakdown,
    subtotalCents: newSubtotalCents,
    adjustmentCents: newSubtotalCents - original,
    priceOverride: { previousSubtotalCents: original, ...meta },
  };
}

/**
 * Strip desk-internal keys from a price breakdown before it crosses to a
 * customer. `priceOverride` carries the owner's free-text reason, the admin's
 * id and the pre-override price — all of it is audit-trail material, none of
 * it is the customer's business. `adjustmentCents` goes too: the customer is
 * owed one honest total, not a running commentary on how it was reached.
 */
export function publicBreakdown(breakdown: OverridableBreakdown): OverridableBreakdown {
  // Copy first, then drop: destructuring-to-omit would leave unused bindings
  // that the linter flags, and the input must not be mutated either way.
  const rest: OverridableBreakdown = { ...breakdown };
  delete rest.priceOverride;
  delete rest.adjustmentCents;
  return rest;
}
