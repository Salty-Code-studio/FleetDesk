/**
 * The single source of truth for booking status moves this wave:
 *   pending -> confirmed -> picked_up -> completed   (+ cancelled from
 *   pending/confirmed only; a car that is OUT cannot be "cancelled", it must
 *   come back through check-out). pending -> picked_up is the desk override
 *   path (completePickup additionally requires an override note for it).
 */
import { Errors } from "@/lib/http/errors";

const ALLOWED: Record<string, string[]> = {
  pending: ["confirmed", "cancelled", "picked_up"],
  confirmed: ["picked_up", "cancelled"],
  picked_up: ["completed"],
  cancelled: [],
  completed: [],
};

export function assertBookingTransition(from: string, to: string): void {
  if (!(ALLOWED[from] ?? []).includes(to)) {
    throw Errors.conflict(`A ${from.replace(/_/g, " ")} booking cannot move to ${to.replace(/_/g, " ")}`);
  }
}
