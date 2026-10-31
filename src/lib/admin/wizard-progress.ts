/**
 * Progress and resume rules for the check-in / check-out wizards (Flow Desk
 * phase 5). Pure, so the ring, the finish checklist and the "open where you
 * stopped" step all read the same facts. Facts come from the handover payload,
 * which lives server-side, so a reload resumes on the first open step.
 */

const ANGLE_IDS = ["front", "back", "left", "right", "interior", "dash"] as const;

export interface ProgressItem { label: string; ok: boolean }
export interface Progress { items: ProgressItem[]; done: number }

export interface CheckinFacts {
  hasLicence: boolean;
  licensePhotoKey: string | null;
  photoLabels: string[];
  odometer: number | null;
  fuelLevel: number | null;
  borgReceivedCents: number | null;
  rulesSigned: boolean;
  signatureKey: string | null;
}

export interface CheckoutFacts {
  /** The return inspection exists: step one saves the damage review. */
  reviewSaved: boolean;
  odometer: number | null;
  fuelLevel: number | null;
  /** Borg taken at pickup; null means there is nothing to hand back. */
  borgReceivedCents: number | null;
  borgReturnedCents: number | null;
  keysReturned: boolean;
}

const tally = (items: ProgressItem[]): Progress => ({ items, done: items.filter((i) => i.ok).length });

const anglesIn = (labels: string[]) => ANGLE_IDS.every((a) => labels.includes(a));
const meterIn = (odometer: number | null, fuel: number | null) => odometer !== null && fuel !== null;
const signed = (f: CheckinFacts) => f.rulesSigned && !!f.signatureKey;

export function checkinProgress(f: CheckinFacts): Progress {
  return tally([
    { label: "Licence on file", ok: f.hasLicence },
    { label: "Licence photo", ok: !!f.licensePhotoKey },
    { label: "Six walk-around angles", ok: anglesIn(f.photoLabels) },
    { label: "Odometer and fuel", ok: meterIn(f.odometer, f.fuelLevel) },
    // "No borg for this rental" stores null, the same as "not asked yet", so
    // the borg only counts as handled once the customer has signed past it.
    { label: "Borg", ok: f.borgReceivedCents !== null || signed(f) },
    { label: "Rules accepted and signed", ok: signed(f) },
  ]);
}

/** First step (1-7) whose gate is still open. Borg has no gate, so it is only
 *  revisited when nothing after it has happened yet. */
export function checkinResumeStep(f: CheckinFacts): number {
  if (!f.hasLicence) return 1;
  if (!f.licensePhotoKey) return 2;
  if (!anglesIn(f.photoLabels)) return 3;
  if (!meterIn(f.odometer, f.fuelLevel)) return 4;
  if (signed(f)) return 7;
  return f.borgReceivedCents === null ? 5 : 6;
}

const borgSettled = (f: CheckoutFacts) => f.borgReceivedCents === null || f.borgReturnedCents !== null;

export function checkoutProgress(f: CheckoutFacts): Progress {
  return tally([
    { label: "Damage review", ok: f.reviewSaved },
    { label: "Odometer and fuel", ok: meterIn(f.odometer, f.fuelLevel) },
    { label: "Borg settled", ok: borgSettled(f) },
    { label: "Keys returned", ok: f.keysReturned },
  ]);
}

export function checkoutResumeStep(f: CheckoutFacts): number {
  if (!f.reviewSaved) return 1;
  if (!meterIn(f.odometer, f.fuelLevel)) return 2;
  if (!borgSettled(f) || !f.keysReturned) return 3;
  return 4;
}

export function ringFraction(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, done / total));
}

/** What the interstitial calls the customer: first word of the name, else the
 *  part of the email before the @. */
export function firstName(name: string | null, email: string): string {
  const word = name?.trim().split(/\s+/)[0];
  if (word) return word;
  const local = email.split("@")[0]?.trim();
  return local || "the customer";
}

/* ------------------------------ finish screens ------------------------------ */

const cash = (cents: number, currency: string) =>
  `${currency} ${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

export interface CheckinSummary {
  vehicle: string; plate: string; customer: string; email: string;
  /** Already formatted for display, e.g. "Aug 4, 2026 at 10:00". */
  returnAt: string; currency: string;
  balanceDueCents: number; wentOutUnpaid: boolean;
  borgReceivedCents: number | null; borgMethod: string | null;
}

/** What the check-in finish screen says got done, one fact per line. */
export function checkinFinishLines(s: CheckinSummary): string[] {
  return [
    `${s.vehicle} (${s.plate}) is out with ${s.customer} until ${s.returnAt}.`,
    s.wentOutUnpaid ? "Went out unpaid. Your override note is on the booking."
      : s.balanceDueCents > 0 ? `${cash(s.balanceDueCents, s.currency)} still open on the booking.`
      : "Paid in full.",
    s.borgReceivedCents !== null
      ? `Borg ${cash(s.borgReceivedCents, s.currency)} taken in ${s.borgMethod ?? "cash"}.`
      : "No borg taken.",
    `Contract on its way to ${s.email}.`,
  ];
}

export interface CheckoutSummary {
  vehicle: string; plate: string; currency: string;
  kmDriven: number | null;
  borgReceivedCents: number | null; borgReturnedCents: number | null;
  damageCount: number;
}

export function checkoutFinishLines(s: CheckoutSummary): string[] {
  const lines = [`${s.vehicle} (${s.plate}) is back on the lot.`];
  if (s.kmDriven !== null) lines.push(`${s.kmDriven.toLocaleString("en-US")} km driven this rental.`);
  if (s.borgReceivedCents !== null) {
    const back = s.borgReturnedCents ?? 0;
    const kept = s.borgReceivedCents - back;
    lines.push(kept > 0
      ? `Borg: ${cash(back, s.currency)} handed back, ${cash(kept, s.currency)} kept.`
      : `Borg ${cash(back, s.currency)} handed back in full.`);
  }
  lines.push(s.damageCount > 0
    ? `${s.damageCount === 1 ? "One new damage" : `${s.damageCount} new damages`} flagged. The owner gets a bell.`
    : "No new damage.");
  return lines;
}
