/**
 * The public booking funnel (Flow Desk phase 4): three screens instead of the
 * old seven steps. Pure, so the page stays a view and the rules stay testable.
 * The licence is no longer part of it; the desk captures it at check-in.
 */
export const SCREENS = ["When and what", "Protect and add", "You and pay"] as const;
export type Screen = 1 | 2 | 3;

export interface FunnelState {
  selectedClass: string;
  pickup: string; ret: string; pickupTime: string; retTime: string;
  /** "under" is the honest answer for a driver below the minimum age: it stops
   *  the booking here instead of at the desk after payment. */
  driverAge: "" | "under" | "young" | "standard";
  /** The operator's minimum driver age, for the "under" message. */
  minDriverAge?: number;
  /** Availability of the chosen class for the chosen dates; null = not checked yet. */
  available: boolean | null;
  customer: { name: string; email: string; phone: string };
  acceptTerms: boolean;
}

export interface ScreenProblem { message: string; field?: string }

/** The first thing stopping the customer leaving screen `n`, or null. `field`
 *  is a selector the page focuses so keyboard users land on the problem. */
export function validateScreen(n: Screen, s: FunnelState): ScreenProblem | null {
  if (n === 1) {
    if (!s.pickup || !s.ret) return { message: "Please choose your pick-up and return dates.", field: "#pickup" };
    if (s.ret <= s.pickup) return { message: "The return date must be after the pick-up date.", field: "#ret" };
    if (!s.pickupTime) return { message: "Please choose a pick-up time.", field: "#pickup-time" };
    if (!s.retTime) return { message: "Please choose a return time.", field: "#ret-time" };
    if (!s.driverAge) return { message: "Please tell us the main driver's age so we can show the right price." };
    if (s.driverAge === "under") {
      return { message: `Sorry, the main driver must be ${s.minDriverAge ?? 18} or older. We cannot rent to younger drivers.` };
    }
    if (!s.selectedClass) return { message: "Please choose a car type to continue." };
    if (s.available === false) return { message: "No cars of this type are free on those dates." };
    return null;
  }
  if (n === 3) {
    if (!s.customer.name.trim()) return { message: "Please enter your full name.", field: "#cust-name" };
    if (!s.customer.email.trim()) return { message: "Please enter your email.", field: "#cust-email" };
    if (!s.customer.phone.trim()) return { message: "Please enter your phone number.", field: "#cust-phone" };
    if (!s.acceptTerms) return { message: "Please accept the terms to reserve.", field: "#accept-terms" };
    if (s.available !== true) return { message: "Your dates are no longer available. Please go back and adjust them." };
  }
  return null;
}

/** Which screen to resume on from sessionStorage. A state saved by the old
 *  seven-step wizard (no `v`) maps by content: class and dates were steps 1-2,
 *  insurance and extras 3-4, licence, details and review 5-7. */
export function screenFromStored(stored: { v?: number; step?: number }): Screen {
  const step = stored.step ?? 1;
  if (stored.v === 2) return Math.min(3, Math.max(1, step)) as Screen;
  if (step >= 5) return 3;
  if (step >= 3) return 2;
  return 1;
}
