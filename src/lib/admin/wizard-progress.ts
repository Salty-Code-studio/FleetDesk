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
