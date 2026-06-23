import { z } from "zod";

/**
 * Money is stored and transported as integer cents — never floats — so totals
 * are exact (spec §3: amounts computed server-side). The UI converts to/from
 * dollars for display only.
 */
export const centsField = z.number().int("must be whole cents").min(0, "must be ≥ 0");
export const optionalCentsField = centsField.nullable().optional();

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function centsToDollars(cents: number): number {
  return cents / 100;
}
