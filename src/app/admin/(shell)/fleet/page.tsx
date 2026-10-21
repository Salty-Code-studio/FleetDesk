"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { apiGet, api, apiPatch, type ApiError } from "../../client";
import {
  Modal,
  Skeleton,
  EmptyState,
  useToast,
  registerPaletteAction,
} from "@/app/admin/_ui";
import { DatePicker, MoneyInput, Select } from "@/components/ui";
import { sortForCards } from "@/lib/admin/fleet-card";
import { CarCard } from "./car-card";
import { CarSheet } from "./car-sheet";
import "./fleet.css";

interface Vehicle {
  id: string; slug: string; plate: string; class: string; name: string;
  make: string | null; model: string | null; year: number | null; color: string | null;
  seats: number;
  transmission: "Automatic" | "Manual"; ac: boolean; doors: number; photos: string[];
  priceDayCents: number; priceWeekCents: number; priceMonthCents: number;
  depositCents: number | null; status: "active" | "maintenance" | "retired";
  insuranceExpiresOn: string | null; inspectionDueOn: string | null;
  openNotes: number;
}

const CLASSES = ["Economy", "Compact", "SUV", "4x4", "Van"];
const composeName = (make: string, model: string) => `${make} ${model}`.replace(/\s+/g, " ").trim();
const empty = {
  slug: "", plate: "", class: "Economy", name: "", seats: "5", transmission: "Automatic",
  ac: true, doors: "4",
  dayCents: null as number | null, weekCents: null as number | null,
  monthCents: null as number | null, depositCents: null as number | null,
  status: "active",
  insurance: "", inspection: "",
  make: "", model: "", year: "", color: "", nameTouched: false,
};

export default function FleetPage() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [f, setF] = useState({ ...empty });
  const [editId, setEditId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [alertDays, setAlertDays] = useState(30);

  const [q, setQ] = useState("");
  const [classFilter, setClassFilter] = useState<string | null>(null);

  const visibleVehicles = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return vehicles.filter((v) => {
      if (classFilter && v.class !== classFilter) return false;
      if (!needle) return true;
      return [v.plate, v.name, v.make ?? "", v.model ?? ""].some((s) => s.toLowerCase().includes(needle));
    });
  }, [vehicles, q, classFilter]);

  const cards = useMemo(() => sortForCards(visibleVehicles, CLASSES), [visibleVehicles]);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const sheetVehicle = vehicles.find((v) => v.id === sheetId) ?? null;

  const toast = useToast();

  async function load() {
    const [vs, s] = await Promise.all([
      apiGet<Vehicle[]>("/api/admin/vehicles"),
      apiGet<{ complianceAlertDays: number }>("/api/admin/settings"),
    ]);
    setVehicles(vs);
    setAlertDays(s.complianceAlertDays);
  }
  useEffect(() => { void load().finally(() => setLoading(false)); }, []);

  function openAdd() {
    setEditId(null);
    setF({ ...empty });
    setFormOpen(true);
  }

  function setIdentity(field: "make" | "model", value: string) {
    setF((prev) => {
      const next = { ...prev, [field]: value };
      if (!prev.nameTouched) next.name = composeName(next.make, next.model);
      return next;
    });
  }

  // Page-scoped command-palette action: "Add vehicle".
  useEffect(
    () =>
      registerPaletteAction({
        id: "fleet-add",
        label: "Add car",
        hint: "Fleet",
        keywords: "vehicle car new add fleet",
        run: () => openAdd(),
      }),
    [],
  );

  async function save(e: FormEvent) {
    e.preventDefault();
    if (f.dayCents === null || f.weekCents === null || f.monthCents === null) {
      toast.show({ type: "error", message: "Enter a price for day, week, and month." });
      return;
    }
    const body = {
      slug: f.slug, plate: f.plate, class: f.class, name: f.name,
      make: f.make.trim() === "" ? null : f.make.trim(),
      model: f.model.trim() === "" ? null : f.model.trim(),
      year: f.year.trim() === "" ? null : Number(f.year),
      color: f.color.trim() === "" ? null : f.color.trim(),
      seats: Number(f.seats),
      transmission: f.transmission, ac: f.ac, doors: Number(f.doors),
      priceDayCents: f.dayCents,
      priceWeekCents: f.weekCents,
      priceMonthCents: f.monthCents,
      depositCents: f.depositCents,
      status: f.status,
      insuranceExpiresOn: f.insurance === "" ? null : f.insurance,
      inspectionDueOn: f.inspection === "" ? null : f.inspection,
    };
    try {
      if (editId) await apiPatch(`/api/admin/vehicles/${editId}`, body);
      else await api("/api/admin/vehicles", body);
      const wasEdit = editId !== null;
      setF({ ...empty }); setEditId(null); await load();
      setFormOpen(false);
      toast.show({ type: "success", message: wasEdit ? "Vehicle updated." : "Vehicle added." });
    } catch (err) { toast.show({ type: "error", message: (err as ApiError).message }); }
  }

  function edit(v: Vehicle) {
    setEditId(v.id);
    setF({
      slug: v.slug, plate: v.plate, class: v.class, name: v.name, seats: v.seats.toString(),
      transmission: v.transmission, ac: v.ac, doors: v.doors.toString(),
      dayCents: v.priceDayCents, weekCents: v.priceWeekCents,
      monthCents: v.priceMonthCents,
      depositCents: v.depositCents,
      status: v.status,
      insurance: v.insuranceExpiresOn ?? "", inspection: v.inspectionDueOn ?? "",
      make: v.make ?? "", model: v.model ?? "",
      year: v.year === null ? "" : v.year.toString(),
      color: v.color ?? "",
      nameTouched: v.name !== composeName(v.make ?? "", v.model ?? ""),
    });
    setFormOpen(true);
  }

  const today = useMemo(() => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Aruba" }).format(new Date()), []);

  return (
    <>
      <header className="fleet-head">
        <div className="fleet-head__lead">
          <h1>Fleet</h1>
          {!loading && <p className="fleet-count">{vehicles.length} {vehicles.length === 1 ? "car" : "cars"}</p>}
        </div>
        <button type="button" className="btn btn--accent fc-add" onClick={openAdd}>Add car</button>
      </header>

      <div className="panel">
        {!loading && vehicles.length > 0 && (
          <div className="fleet-filters">
            <input
              type="search"
              className="fleet-search"
              placeholder="Search plate, make, model or name"
              aria-label="Search vehicles"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="fleet-chips" role="group" aria-label="Filter by class">
              <button type="button" className={`fleet-chip ${classFilter === null ? "is-on" : ""}`} onClick={() => setClassFilter(null)}>All</button>
              {CLASSES.map((c) => (
                <button key={c} type="button" className={`fleet-chip ${classFilter === c ? "is-on" : ""}`} onClick={() => setClassFilter(classFilter === c ? null : c)}>{c}</button>
              ))}
            </div>
          </div>
        )}

        {loading ? (
          <div className="fc-grid" aria-busy="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="fc-card fc-card--skeleton">
                <Skeleton width="100%" height={110} radius={0} />
                <div className="fc-card__body">
                  <Skeleton width="70%" />
                  <Skeleton width="40%" />
                  <Skeleton width="90%" />
                </div>
              </div>
            ))}
          </div>
        ) : vehicles.length === 0 ? (
          <EmptyState
            title="No cars yet"
            hint="Add your first car to start taking bookings online."
            action={<button type="button" className="btn" onClick={openAdd}>Add car</button>}
          />
        ) : cards.length === 0 ? (
          <p className="muted">No cars match. Try a different search or clear the class filter.</p>
        ) : (
          <div className="fc-grid">
            {cards.map((v) => (
              <CarCard key={v.id} v={v} today={today} alertDays={alertDays} onOpen={() => setSheetId(v.id)} onEditRates={() => edit(v)} />
            ))}
          </div>
        )}
      </div>

      <Modal
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditId(null); setF({ ...empty }); }}
        title={editId ? "Edit car" : "Add car"}
        description="Rates are in USD. Leave deposit blank to mark it as to be confirmed."
        size="lg"
        footer={
          <>
            <button type="button" className="btn btn--quiet" onClick={() => { setFormOpen(false); setEditId(null); setF({ ...empty }); }}>Cancel</button>
            <button type="submit" form="fleet-form" className="btn btn--accent">{editId ? "Update vehicle" : "Add vehicle"}</button>
          </>
        }
      >
        <form id="fleet-form" onSubmit={save}>
          <div className="form-grid">
            <label>Make<input data-autofocus value={f.make} onChange={(e) => setIdentity("make", e.target.value)} placeholder="Kia" /></label>
            <label>Model<input value={f.model} onChange={(e) => setIdentity("model", e.target.value)} placeholder="Picanto" /></label>
            <label>Year<input type="number" min="1950" max="2100" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })} placeholder="2023" /></label>
            <label>Color<input value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} placeholder="White" /></label>
            <label>Name (shown to customers)<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, nameTouched: e.target.value !== "" })} /></label>
            <label>Plate (registration / row ID)<input required value={f.plate} onChange={(e) => setF({ ...f, plate: e.target.value })} placeholder="A-1234" /></label>
            <label>Slug (kebab-case)<input required value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} placeholder="kia-picanto" /></label>
            <label>Class<Select value={f.class} onChange={(v) => setF({ ...f, class: v })} options={CLASSES.map((c) => ({ value: c, label: c }))} /></label>
            <label>Transmission<Select value={f.transmission} onChange={(v) => setF({ ...f, transmission: v })} options={[{ value: "Automatic", label: "Automatic" }, { value: "Manual", label: "Manual" }]} /></label>
            <label>Seats<input type="number" min="1" max="20" value={f.seats} onChange={(e) => setF({ ...f, seats: e.target.value })} /></label>
            <label>Doors<input type="number" min="1" max="8" value={f.doors} onChange={(e) => setF({ ...f, doors: e.target.value })} /></label>
            <label>Price / day (USD)<MoneyInput required cents={f.dayCents} ariaLabel="Price per day (USD)" onChange={(cents) => setF({ ...f, dayCents: cents })} /></label>
            <label>Price / week (USD)<MoneyInput required cents={f.weekCents} ariaLabel="Price per week (USD)" onChange={(cents) => setF({ ...f, weekCents: cents })} /></label>
            <label>Price / month (USD)<MoneyInput required cents={f.monthCents} ariaLabel="Price per month (USD)" onChange={(cents) => setF({ ...f, monthCents: cents })} /></label>
            <label>Deposit (USD, blank = TBC)<MoneyInput cents={f.depositCents} ariaLabel="Deposit (USD)" onChange={(cents) => setF({ ...f, depositCents: cents })} /></label>
            <label>Insurance expires<DatePicker value={f.insurance} onChange={(iso) => setF({ ...f, insurance: iso })} ariaLabel="Insurance expires" placeholder="Not tracked" /></label>
            <label>Inspection due<DatePicker value={f.inspection} onChange={(iso) => setF({ ...f, inspection: iso })} ariaLabel="Inspection due" placeholder="Not tracked" /></label>
            <label>Status<Select value={f.status} onChange={(v) => setF({ ...f, status: v })} options={[{ value: "active", label: "active" }, { value: "maintenance", label: "maintenance" }, { value: "retired", label: "retired" }]} /></label>
            <label className="check fleet-check"><input type="checkbox" checked={f.ac} onChange={(e) => setF({ ...f, ac: e.target.checked })} /> Air conditioning</label>
          </div>
        </form>
      </Modal>

      <CarSheet vehicle={sheetVehicle} onClose={() => setSheetId(null)} onChanged={load} onEditRates={(c) => { const full = vehicles.find((x) => x.id === c.id); if (full) edit(full); }} />
    </>
  );
}
