/**
 * Rental contract PDF (spec W4 step 7). Rendered SERVER-SIDE with
 * @react-pdf/renderer at check-in completion, stored at contracts/{bookingId}.pdf
 * and attached to the pickup email. Built-in Helvetica only (no font fetches,
 * CSP-irrelevant server-side, deterministic output). Brand accents follow the
 * email templates (#2348c7 ink-blue, #f15f2c pop).
 */
import { Document, Page, Text, View, Image, StyleSheet, renderToBuffer } from "@react-pdf/renderer";

export interface ContractLine { label: string; amount: string }

export interface ContractData {
  operatorName: string;
  contractRef: string;
  generatedAt: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  driverName: string;
  licenseCountry: string;
  vehicleName: string;
  vehiclePlate: string;
  vehicleClass: string;
  periodStart: string;
  periodEnd: string;
  lines: ContractLine[];
  totalAmount: string;
  paidAmount: string;
  balanceDue: string;
  borgLine: string;
  policyVersion: number;
  policyText: string;
  signaturePngDataUrl: string | null;
  photoCount: number;
  odometer: string;
  fuel: string;
}

const BRAND = "#2348c7";
const INK = "#15192f";
const MUTED = "#828aa6";

const s = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: "Helvetica", color: INK },
  brand: { fontSize: 16, fontFamily: "Helvetica-Bold", letterSpacing: 1, marginBottom: 2 },
  subtitle: { color: MUTED, marginBottom: 16 },
  h2: { fontSize: 12, fontFamily: "Helvetica-Bold", color: BRAND, marginTop: 14, marginBottom: 6 },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 3 },
  label: { color: MUTED },
  value: { fontFamily: "Helvetica-Bold" },
  divider: { borderBottomWidth: 1, borderBottomColor: "#e3e6f0", marginVertical: 8 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 4, paddingTop: 4, borderTopWidth: 1, borderTopColor: INK },
  policy: { fontSize: 8, color: INK, lineHeight: 1.5, marginTop: 4 },
  signatureBox: { marginTop: 10, borderWidth: 1, borderColor: "#e3e6f0", borderRadius: 4, padding: 8, height: 90 },
  signatureImg: { height: 60, objectFit: "contain", alignSelf: "flex-start" },
  footer: { position: "absolute", bottom: 24, left: 40, right: 40, color: MUTED, fontSize: 8, textAlign: "center" },
});

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.row}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.value}>{value}</Text>
    </View>
  );
}

function ContractDoc({ d }: { d: ContractData }) {
  return (
    <Document title={`Rental contract ${d.contractRef}`} author={d.operatorName}>
      <Page size="A4" style={s.page}>
        <Text style={s.brand}>{d.operatorName.toUpperCase()}</Text>
        <Text style={s.subtitle}>Rental contract {d.contractRef} · generated {d.generatedAt}</Text>

        <Text style={s.h2}>Renter</Text>
        <Fact label="Name" value={d.customerName} />
        <Fact label="Email" value={d.customerEmail} />
        {d.customerPhone ? <Fact label="Phone" value={d.customerPhone} /> : null}
        <Fact label="Driver on licence" value={d.driverName} />
        {d.licenseCountry ? <Fact label="Licence country" value={d.licenseCountry} /> : null}

        <Text style={s.h2}>Vehicle and period</Text>
        <Fact label="Vehicle" value={`${d.vehicleName} (${d.vehicleClass})`} />
        <Fact label="Plate" value={d.vehiclePlate} />
        <Fact label="Pickup" value={d.periodStart} />
        <Fact label="Return" value={d.periodEnd} />
        <Fact label="Odometer at pickup" value={d.odometer || "not recorded"} />
        <Fact label="Fuel at pickup" value={d.fuel || "not recorded"} />
        <Fact label="Condition photos on file" value={String(d.photoCount)} />

        <Text style={s.h2}>Charges</Text>
        {d.lines.map((l) => <Fact key={l.label} label={l.label} value={l.amount} />)}
        <View style={s.totalRow}>
          <Text style={s.value}>Rental total</Text>
          <Text style={s.value}>{d.totalAmount}</Text>
        </View>
        <Fact label="Paid" value={d.paidAmount} />
        <Fact label="Balance due" value={d.balanceDue} />
        <Fact label="Security deposit (borg)" value={d.borgLine} />

        <Text style={s.h2}>Rental terms (version {d.policyVersion})</Text>
        <Text style={s.policy}>{d.policyText}</Text>

        <Text style={s.h2}>Customer signature</Text>
        <View style={s.signatureBox}>
          {d.signaturePngDataUrl
            // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer's Image is a PDF drawing primitive, not an HTML <img>; there is no DOM/accessibility tree here.
            ? <Image style={s.signatureImg} src={d.signaturePngDataUrl} />
            : <Text style={s.label}>Signed on the staff device</Text>}
          <Text style={{ color: MUTED, marginTop: 6 }}>
            {d.customerName} accepted rental terms version {d.policyVersion} at check-in.
          </Text>
        </View>

        <Text style={s.footer}>{d.operatorName} · contract {d.contractRef}</Text>
      </Page>
    </Document>
  );
}

export async function renderContractPdf(data: ContractData): Promise<Uint8Array> {
  const buffer = await renderToBuffer(<ContractDoc d={data} />);
  return new Uint8Array(buffer);
}
