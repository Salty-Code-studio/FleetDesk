import { describe, it, expect } from "vitest";
import {
  checkinProgress, checkinResumeStep, checkoutProgress, checkoutResumeStep,
  ringFraction, firstName, checkinFinishLines, checkoutFinishLines,
  type CheckinFacts, type CheckoutFacts,
} from "../lib/admin/wizard-progress";

const ANGLES = ["front", "back", "left", "right", "interior", "dash"];

const blankIn: CheckinFacts = {
  fresh: false, deskAttention: false, hasLicence: false, licensePhotoKey: null, photoLabels: [], damageCheck: null, odometer: null, fuelLevel: null,
  borgReceivedCents: null, borgMethod: null, rulesSigned: false, signatureKey: null,
};
const fullIn: CheckinFacts = {
  fresh: false, deskAttention: false, hasLicence: true, licensePhotoKey: "l", photoLabels: ["damage: dent"], damageCheck: "found", odometer: 1200, fuelLevel: 8,
  borgReceivedCents: 50000, borgMethod: "card", rulesSigned: true, signatureKey: "s",
};

describe("checkin progress", () => {
  it("nothing done is an empty ring", () => {
    const p = checkinProgress(blankIn);
    expect(p.done).toBe(0);
    expect(p.items.map((i) => i.label)).toEqual([
      "Licence on file", "Licence photo", "Damage check", "Odometer and fuel", "Borg", "Rules accepted and signed",
    ]);
  });

  it("everything done is a full ring", () => {
    const p = checkinProgress(fullIn);
    expect(p.done).toBe(p.items.length);
  });

  const damageItem = (f: CheckinFacts) => checkinProgress(f).items.find((i) => i.label === "Damage check")!.ok;

  it("No damage answers the damage check without any photo", () => {
    expect(damageItem({ ...blankIn, damageCheck: "none" })).toBe(true);
  });

  it("damage marked but not photographed is still open", () => {
    expect(damageItem({ ...blankIn, damageCheck: "found" })).toBe(false);
    expect(damageItem({ ...blankIn, damageCheck: "found", photoLabels: ["damage: scratch rear bumper"] })).toBe(true);
  });

  it("an older six-angle check-in still counts; five angles does not", () => {
    expect(damageItem({ ...blankIn, photoLabels: ANGLES })).toBe(true);
    expect(damageItem({ ...blankIn, photoLabels: ANGLES.slice(0, 5) })).toBe(false);
  });

  it("no borg counts once the customer has signed past it", () => {
    const p = checkinProgress({ ...fullIn, borgReceivedCents: null });
    expect(p.items.find((i) => i.label === "Borg")!.ok).toBe(true);
    const early = checkinProgress({ ...fullIn, borgReceivedCents: null, signatureKey: null, rulesSigned: false });
    expect(early.items.find((i) => i.label === "Borg")!.ok).toBe(false);
  });

  it("no borg counts as soon as the desk says so", () => {
    const p = checkinProgress({ ...blankIn, borgMethod: "none" });
    expect(p.items.find((i) => i.label === "Borg")!.ok).toBe(true);
    expect(checkinResumeStep({ ...fullIn, borgReceivedCents: null, borgMethod: "none", rulesSigned: false, signatureKey: null })).toBe(6);
  });

  it("fuel level 0 (empty tank) still counts as recorded", () => {
    const p = checkinProgress({ ...blankIn, odometer: 0, fuelLevel: 0 });
    expect(p.items.find((i) => i.label === "Odometer and fuel")!.ok).toBe(true);
  });
});

describe("checkin resume step", () => {
  it("starts at verify with no licence", () => expect(checkinResumeStep(blankIn)).toBe(1));
  it("goes to the licence photo once the licence is saved", () =>
    expect(checkinResumeStep({ ...blankIn, hasLicence: true })).toBe(2));
  it("goes to the damage check after the licence photo", () =>
    expect(checkinResumeStep({ ...blankIn, hasLicence: true, licensePhotoKey: "l" })).toBe(3));
  it("goes to odometer once the desk tapped No damage", () =>
    expect(checkinResumeStep({ ...blankIn, hasLicence: true, licensePhotoKey: "l", damageCheck: "none" })).toBe(4));
  it("stays on the damage check while found damage has no photo", () =>
    expect(checkinResumeStep({ ...blankIn, hasLicence: true, licensePhotoKey: "l", damageCheck: "found" })).toBe(3));
  it("goes to borg when odometer and fuel are in but nothing is signed", () =>
    expect(checkinResumeStep({ ...fullIn, borgReceivedCents: null, rulesSigned: false, signatureKey: null })).toBe(5));
  it("skips borg when it is already recorded", () =>
    expect(checkinResumeStep({ ...fullIn, rulesSigned: false, signatureKey: null })).toBe(6));
  it("lands on finish when everything is in", () => expect(checkinResumeStep(fullIn)).toBe(7));
  it("a fresh check-in opens on step one even with a licence on file", () =>
    expect(checkinResumeStep({ ...blankIn, fresh: true, hasLicence: true })).toBe(1));
  it("a balance due or licence mismatch opens on step one", () =>
    expect(checkinResumeStep({ ...fullIn, deskAttention: true })).toBe(1));
});

const blankOut: CheckoutFacts = {
  reviewSaved: false, odometer: null, fuelLevel: null, borgReceivedCents: 50000, borgReturnedCents: null, keysReturned: false,
};

describe("checkout progress and resume", () => {
  it("lists the four return items", () => {
    expect(checkoutProgress(blankOut).items.map((i) => i.label)).toEqual([
      "Damage review", "Odometer and fuel", "Borg settled", "Keys returned",
    ]);
    expect(checkoutProgress(blankOut).done).toBe(0);
  });

  it("borg is settled when none was taken at pickup", () => {
    const p = checkoutProgress({ ...blankOut, borgReceivedCents: null });
    expect(p.items.find((i) => i.label === "Borg settled")!.ok).toBe(true);
  });

  it("resumes on the first open step", () => {
    expect(checkoutResumeStep(blankOut)).toBe(1);
    expect(checkoutResumeStep({ ...blankOut, reviewSaved: true })).toBe(2);
    expect(checkoutResumeStep({ ...blankOut, reviewSaved: true, odometer: 10, fuelLevel: 0 })).toBe(3);
    expect(checkoutResumeStep({ ...blankOut, reviewSaved: true, odometer: 10, fuelLevel: 0, borgReturnedCents: 50000 })).toBe(3);
    expect(checkoutResumeStep({ reviewSaved: true, odometer: 10, fuelLevel: 0, borgReceivedCents: 50000, borgReturnedCents: 0, keysReturned: true })).toBe(4);
  });
});

describe("ringFraction", () => {
  it("clamps and guards zero totals", () => {
    expect(ringFraction(0, 0)).toBe(0);
    expect(ringFraction(3, 6)).toBe(0.5);
    expect(ringFraction(9, 6)).toBe(1);
  });
});

describe("firstName", () => {
  it("takes the first word, falls back to the email name", () => {
    expect(firstName("Maria van Dijk", "m@x.com")).toBe("Maria");
    expect(firstName(null, "jan.de.vries@x.com")).toBe("jan.de.vries");
    expect(firstName("   ", "")).toBe("the customer");
  });
});

describe("finish lines", () => {
  const base = {
    vehicle: "Jeep Wrangler", plate: "A-123", customer: "Maria", email: "m@x.com",
    returnAt: "Aug 4, 2026 at 10:00", currency: "USD",
    balanceDueCents: 0, wentOutUnpaid: false, borgReceivedCents: 50000, borgMethod: "card",
  };

  it("check-in says who has the car, money, borg and contract", () => {
    expect(checkinFinishLines(base).map((l) => l.text)).toEqual([
      "Jeep Wrangler (A-123) is out with Maria until Aug 4, 2026 at 10:00.",
      "Paid in full.",
      "Borg USD 500 taken in card.",
      "Contract on its way to m@x.com.",
    ]);
  });

  it("an open balance is marked open, not ticked", () => {
    expect(checkinFinishLines({ ...base, balanceDueCents: 15000 })[1]).toEqual({ text: "USD 150 still open on the booking.", open: true });
  });

  it("check-in names an unpaid handover and a missing borg", () => {
    const lines = checkinFinishLines({ ...base, wentOutUnpaid: true, borgReceivedCents: null });
    expect(lines[1]).toEqual({ text: "Went out unpaid. Your override note is on the booking.", open: true });
    expect(lines[2]).toEqual({ text: "No borg taken." });
  });

  it("check-out reports km, borg kept and damage", () => {
    expect(checkoutFinishLines({
      vehicle: "Jeep", plate: "A-1", currency: "USD", kmDriven: 1234,
      borgReceivedCents: 50000, borgReturnedCents: 35050, damageCount: 2,
    }).map((l) => l.text)).toEqual([
      "Jeep (A-1) is back on the lot.",
      "1,234 km driven this rental.",
      "Borg: USD 350.50 handed back, USD 149.50 kept.",
      "2 new damages flagged. The owner gets a bell.",
    ]);
  });

  it("check-out without borg or km stays short", () => {
    expect(checkoutFinishLines({
      vehicle: "Jeep", plate: "A-1", currency: "USD", kmDriven: null,
      borgReceivedCents: null, borgReturnedCents: null, damageCount: 0,
    })).toEqual([{ text: "Jeep (A-1) is back on the lot." }, { text: "No new damage." }]);
  });
});
