import { describe, it, expect } from "vitest";
import { SCREENS, validateScreen, screenFromStored, type FunnelState } from "@/lib/booking/funnel";

const ok: FunnelState = {
  selectedClass: "SUV", pickup: "2027-01-10", ret: "2027-01-14", pickupTime: "09:00", retTime: "09:00",
  driverAge: "standard", available: true,
  customer: { name: "Sam", email: "sam@example.com", phone: "+297 555" }, acceptTerms: true,
};

describe("SCREENS", () => {
  it("names the three screens", () => {
    expect(SCREENS).toEqual(["When and what", "Protect and add", "You and pay"]);
  });
});

describe("validateScreen", () => {
  it("passes a complete state on every screen", () => {
    expect(validateScreen(1, ok)).toBeNull();
    expect(validateScreen(2, ok)).toBeNull();
    expect(validateScreen(3, ok)).toBeNull();
  });

  it("screen one asks for dates, order, times, age, class and availability in that order", () => {
    expect(validateScreen(1, { ...ok, pickup: "" })).toEqual({ message: "Please choose your pick-up and return dates.", field: "#pickup" });
    expect(validateScreen(1, { ...ok, ret: "2027-01-10" })).toEqual({ message: "The return date must be after the pick-up date.", field: "#ret" });
    expect(validateScreen(1, { ...ok, pickupTime: "" })?.field).toBe("#pickup-time");
    expect(validateScreen(1, { ...ok, retTime: "" })?.field).toBe("#ret-time");
    expect(validateScreen(1, { ...ok, driverAge: "" })?.message).toBe("Please tell us the main driver's age so we can show the right price.");
    expect(validateScreen(1, { ...ok, selectedClass: "" })?.message).toBe("Please choose a car type to continue.");
    expect(validateScreen(1, { ...ok, available: false })?.message).toBe("No cars of this type are free on those dates.");
  });

  it("screen two never blocks", () => {
    expect(validateScreen(2, { ...ok, selectedClass: "", pickup: "" })).toBeNull();
  });

  it("screen three asks for name, email, phone and the terms", () => {
    expect(validateScreen(3, { ...ok, customer: { ...ok.customer, name: " " } })?.field).toBe("#cust-name");
    expect(validateScreen(3, { ...ok, customer: { ...ok.customer, email: "" } })?.field).toBe("#cust-email");
    expect(validateScreen(3, { ...ok, customer: { ...ok.customer, phone: "" } })?.field).toBe("#cust-phone");
    expect(validateScreen(3, { ...ok, acceptTerms: false })).toEqual({ message: "Please accept the terms to reserve.", field: "#accept-terms" });
    expect(validateScreen(3, { ...ok, available: false })?.message).toBe("Your dates are no longer available. Please go back and adjust them.");
  });
});

describe("screenFromStored", () => {
  it("maps the old seven-step wizard onto the three screens", () => {
    expect(screenFromStored({ step: 1 })).toBe(1);
    expect(screenFromStored({ step: 2 })).toBe(1);
    expect(screenFromStored({ step: 3 })).toBe(2);
    expect(screenFromStored({ step: 4 })).toBe(2);
    expect(screenFromStored({ step: 5 })).toBe(3);
    expect(screenFromStored({ step: 7 })).toBe(3);
  });

  it("clamps a stored three-screen step and defaults to one", () => {
    expect(screenFromStored({ v: 2, step: 2 })).toBe(2);
    expect(screenFromStored({ v: 2, step: 9 })).toBe(3);
    expect(screenFromStored({ v: 2, step: 0 })).toBe(1);
    expect(screenFromStored({})).toBe(1);
  });
});
