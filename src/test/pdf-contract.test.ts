import { describe, it, expect } from "vitest";
import { renderContractPdf, type ContractData } from "@/lib/pdf/contract";

const data: ContractData = {
  operatorName: "FleetDesk",
  contractRef: "AB12CD34",
  generatedAt: "Aug 1, 2026 at 09:00",
  customerName: "Jane Tester",
  customerEmail: "jane@test.com",
  customerPhone: "+297 555 0100",
  driverName: "Jane Tester",
  licenseCountry: "Netherlands",
  vehicleName: "Kia Sportage",
  vehiclePlate: "A-12345",
  vehicleClass: "SUV",
  periodStart: "Aug 1, 2026 at 09:00",
  periodEnd: "Aug 5, 2026 at 09:00",
  lines: [
    { label: "Vehicle (4 days)", amount: "USD 400.00" },
    { label: "Insurance", amount: "USD 60.00" },
  ],
  totalAmount: "USD 460.00",
  paidAmount: "USD 460.00",
  balanceDue: "USD 0.00",
  borgLine: "USD 250.00 received in cash (refundable at return)",
  policyVersion: 3,
  policyText: "Drive nicely. Bring it back with the same fuel level.",
  signaturePngDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  photoCount: 6,
  odometer: "41250",
  fuel: "3/4",
};

describe("renderContractPdf", () => {
  it("renders a real PDF byte stream", async () => {
    const bytes = await renderContractPdf(data);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(Buffer.from(bytes.slice(0, 5)).toString("ascii")).toBe("%PDF-");
  });

  it("renders without a signature image too", async () => {
    const bytes = await renderContractPdf({ ...data, signaturePngDataUrl: null });
    expect(Buffer.from(bytes.slice(0, 5)).toString("ascii")).toBe("%PDF-");
  });
});
