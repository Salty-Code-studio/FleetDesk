"use client";

import { Fragment, useEffect, useMemo, useState, type FormEvent } from "react";
import { apiGet, api, apiPatch, apiDelete, type ApiError } from "../../client";
import {
  Modal,
  Drawer,
  Skeleton,
  EmptyState,
  useToast,
  useConfirm,
  registerPaletteAction,
} from "@/app/admin/_ui";
import { DatePicker, Select, TimeSelect } from "@/components/ui";
import { atAruba } from "@/lib/time/format";
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
interface Block { id: string; startDate: string; endDate: string; type: string; reason: string }
interface Note { id: string; body: string; createdAt: string; resolvedAt: string | null }

const CLASSES = ["Economy", "Compact", "SUV", "4x4", "Van"];
const SPAN_ALL = 99; // colSpan that always covers every column, even ones other plans add
const composeName = (make: string, model: string) => `${make} ${model}`.replace(/\s+/g, " ").trim();
const BLOCK_TYPES = ["maintenance", "carwash", "cleaning", "out_of_service", "other"];
const empty = {
  slug: "", plate: "", class: "Economy", name: "", seats: "5", transmission: "Automatic",
  ac: true, doors: "4", day: "", week: "", month: "", deposit: "", status: "active",
  insurance: "", inspection: "",
  make: "", model: "", year: "", color: "", nameTouched: false,
};

export default function FleetPage() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [f, setF] = useState({ ...empty });
  const [editId, setEditId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [blocksFor, setBlocksFor] = useState<Vehicle | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [bo, setBo] = useState({ startDate: "", startTime: "00:00", endDate: "", endTime: "00:00", type: "maintenance", reason: "" });
  const [alertDays, setAlertDays] = useState(30);
  const [notesFor, setNotesFor] = useState<Vehicle | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteBody, setNoteBody] = useState("");

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

  const groups = useMemo(() => {
    const order = (c: string) => { const i = CLASSES.indexOf(c); return i < 0 ? 99 : i; };
    const classes = [...new Set(visibleVehicles.map((v) => v.class))].sort((a, b) => order(a) - order(b));
    return classes.map((cls) => ({ class: cls, vehicles: visibleVehicles.filter((v) => v.class === cls) }));
  }, [visibleVehicles]);

  const toast = useToast();
  const confirm = useConfirm();

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
        label: "Add vehicle",
        hint: "Fleet",
        keywords: "vehicle car new add fleet",
        run: () => openAdd(),
      }),
    [],
  );

  async function save(e: FormEvent) {
    e.preventDefault();
    const body = {
      slug: f.slug, plate: f.plate, class: f.class, name: f.name,
      make: f.make.trim() === "" ? null : f.make.trim(),
      model: f.model.trim() === "" ? null : f.model.trim(),
      year: f.year.trim() === "" ? null : Number(f.year),
      color: f.color.trim() === "" ? null : f.color.trim(),
      seats: Number(f.seats),
      transmission: f.transmission, ac: f.ac, doors: Number(f.doors),
      priceDayCents: Math.round(Number(f.day) * 100),
      priceWeekCents: Math.round(Number(f.week) * 100),
      priceMonthCents: Math.round(Number(f.month) * 100),
      depositCents: f.deposit === "" ? null : Math.round(Number(f.deposit) * 100),
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
      day: (v.priceDayCents / 100).toString(), week: (v.priceWeekCents / 100).toString(),
      month: (v.priceMonthCents / 100).toString(),
      deposit: v.depositCents === null ? "" : (v.depositCents / 100).toString(),
      status: v.status,
      insurance: v.insuranceExpiresOn ?? "", inspection: v.inspectionDueOn ?? "",
      make: v.make ?? "", model: v.model ?? "",
      year: v.year === null ? "" : v.year.toString(),
      color: v.color ?? "",
      nameTouched: v.name !== composeName(v.make ?? "", v.model ?? ""),
    });
    setFormOpen(true);
  }

  async function retire(v: Vehicle) {
    const ok = await confirm({
      title: "Retire this vehicle?",
      message: `${v.name} (${v.plate}) will be hidden from booking. Its history stays intact and you can reactivate it later.`,
      confirmLabel: "Retire vehicle",
      danger: true,
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/admin/vehicles/${v.id}`);
      await load();
      toast.show({ type: "success", message: "Vehicle retired." });
    } catch (err) { toast.show({ type: "error", message: (err as ApiError).message }); }
  }

  async function openBlocks(v: Vehicle) {
    setBlocksFor(v);
    setBlocks(await apiGet<Block[]>(`/api/admin/vehicles/${v.id}/blocks`));
  }
  async function addBlock(e: FormEvent) {
    e.preventDefault();
    if (!blocksFor) return;
    try {
      await api(`/api/admin/vehicles/${blocksFor.id}/blocks`, {
        startAt: atAruba(bo.startDate, bo.startTime), endAt: atAruba(bo.endDate, bo.endTime),
        type: bo.type, reason: bo.reason,
      });
      setBo({ startDate: "", startTime: "00:00", endDate: "", endTime: "00:00", type: "maintenance", reason: "" });
      setBlocks(await apiGet<Block[]>(`/api/admin/vehicles/${blocksFor.id}/blocks`));
      toast.show({ type: "success", message: "Block added." });
    } catch (err) { toast.show({ type: "error", message: (err as ApiError).message }); }
  }
  async function removeBlock(id: string) {
    const ok = await confirm({
      title: "Delete this block?",
      message: "The dates open back up for booking.",
      confirmLabel: "Delete block",
      danger: true,
    });
    if (!ok) return;
    await apiDelete(`/api/admin/blocks/${id}`);
    if (blocksFor) setBlocks(await apiGet<Block[]>(`/api/admin/vehicles/${blocksFor.id}/blocks`));
    toast.show({ type: "success", message: "Block deleted." });
  }

  async function openNotes(v: Vehicle) {
    setNotesFor(v);
    setNotes(await apiGet<Note[]>(`/api/admin/vehicles/${v.id}/notes`));
  }
  async function refreshNotes(vehicleId: string) {
    setNotes(await apiGet<Note[]>(`/api/admin/vehicles/${vehicleId}/notes`));
    await load(); // badge counts on the rows come from the vehicles list
  }
  async function addNote(e: FormEvent) {
    e.preventDefault();
    if (!notesFor) return;
    try {
      await api(`/api/admin/vehicles/${notesFor.id}/notes`, { body: noteBody });
      setNoteBody("");
      await refreshNotes(notesFor.id);
      toast.show({ type: "success", message: "Note added." });
    } catch (err) { toast.show({ type: "error", message: (err as ApiError).message }); }
  }
  async function resolveNote(n: Note, resolved: boolean) {
    if (!notesFor) return;
    try {
      await apiPatch(`/api/admin/notes/${n.id}`, { resolved });
      await refreshNotes(notesFor.id);
      toast.show({ type: "success", message: resolved ? "Note resolved." : "Note reopened." });
    } catch (err) { toast.show({ type: "error", message: (err as ApiError).message }); }
  }
  async function escalateNote(n: Note) {
    if (!notesFor) return;
    const ok = await confirm({
      title: "Block this car?",
      message: `${notesFor.plate} gets a 7 day maintenance block starting today for: "${n.body}". You can adjust or remove it under Blocks. The note stays open until you resolve it.`,
      confirmLabel: "Block car",
    });
    if (!ok) return;
    try {
      await api(`/api/admin/notes/${n.id}/escalate`, {});
      await refreshNotes(notesFor.id);
      toast.show({ type: "success", message: "Car blocked for 7 days. Adjust it under Blocks if needed." });
    } catch (err) { toast.show({ type: "error", message: (err as ApiError).message }); }
  }

  const money = (c: number) => `$${(c / 100).toFixed(0)}`;
  const statusTag = (s: Vehicle["status"]) =>
    s === "active" ? "on" : s === "retired" ? "off" : "def";
  const today = useMemo(() => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Aruba" }).format(new Date()), []);
  const daysLeft = (dueOn: string) => Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  function complianceBadges(v: Vehicle) {
    const out: { key: string; label: string; overdue: boolean }[] = [];
    for (const [name, dueOn] of [["Insurance", v.insuranceExpiresOn], ["Inspection", v.inspectionDueOn]] as const) {
      if (!dueOn) continue;
      const d = daysLeft(dueOn);
      if (d > alertDays) continue;
      out.push({ key: name, label: d < 0 ? `${name} overdue` : `${name} ${d}d`, overdue: d < 0 });
    }
    return out;
  }

  return (
    <>
      <header className="fleet-head">
        <div className="fleet-head__lead">
          <h1>Fleet &amp; pricing</h1>
          <p className="sub">The vehicles, rates, and deposits offered online. Retiring keeps booking history; it just hides the car.</p>
        </div>
      </header>

      <div className="panel">
        <div className="fleet-panel-head">
          <h2>Vehicles</h2>
          <div className="fleet-panel-head__right">
            {!loading && vehicles.length > 0 && (
              <span className="fleet-count">{vehicles.length} total</span>
            )}
            <button type="button" className="btn btn--accent" onClick={openAdd}>Add vehicle</button>
          </div>
        </div>

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
          <table className="grid fleet-grid" aria-busy="true">
            <thead><tr><th>Plate</th><th>Name</th><th>Class</th><th className="num">Day</th><th className="num">Week</th><th className="num">Month</th><th className="num">Deposit</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {Array.from({ length: 4 }).map((_, r) => (
                <tr key={r}>
                  <td><Skeleton width="60%" /></td>
                  <td><Skeleton width="80%" /></td>
                  <td><Skeleton width="50%" /></td>
                  <td className="num"><Skeleton width="40%" /></td>
                  <td className="num"><Skeleton width="40%" /></td>
                  <td className="num"><Skeleton width="40%" /></td>
                  <td className="num"><Skeleton width="40%" /></td>
                  <td><Skeleton width={64} radius={6} /></td>
                  <td><Skeleton width="70%" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : vehicles.length === 0 ? (
          <EmptyState
            title="No vehicles yet"
            hint="Add your first car to start taking bookings online."
            action={<button type="button" className="btn btn--accent" onClick={openAdd}>Add vehicle</button>}
          />
        ) : (
          <table className="grid fleet-grid">
            <thead><tr><th>Plate</th><th>Name</th><th>Class</th><th className="num">Day</th><th className="num">Week</th><th className="num">Month</th><th className="num">Deposit</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {groups.length === 0 ? (
                <tr><td colSpan={SPAN_ALL} className="muted">No cars match. Try a different search or clear the class filter.</td></tr>
              ) : groups.map((g) => (
                <Fragment key={g.class}>
                  <tr className="fleet-group-row">
                    <td colSpan={SPAN_ALL}>{g.class}<span className="fleet-group-count">{g.vehicles.length} {g.vehicles.length === 1 ? "car" : "cars"}</span></td>
                  </tr>
                  {g.vehicles.map((v) => (
                    <tr key={v.id}>
                      <td><b>{v.plate}</b>{v.openNotes > 0 && <span className="fleet-note-badge" title={`${v.openNotes} open ${v.openNotes === 1 ? "note" : "notes"}`}>{v.openNotes}</span>}</td>
                      <td>{v.name}<div className="fleet-slug">{v.slug}</div>
                        {complianceBadges(v).length > 0 && (
                          <div className="fleet-compliance">
                            {complianceBadges(v).map((b) => (
                              <span key={b.key} className={`tag ${b.overdue ? "off" : "warn"}`}>{b.label}</span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>{v.class}</td>
                      <td className="num">{money(v.priceDayCents)}</td>
                      <td className="num">{money(v.priceWeekCents)}</td>
                      <td className="num">{money(v.priceMonthCents)}</td>
                      <td className="num">{v.depositCents === null ? "TBC" : money(v.depositCents)}</td>
                      <td><span className={`tag ${statusTag(v.status)}`}>{v.status}</span></td>
                      <td className="fleet-actions"><div className="row-actions">
                        <button onClick={() => edit(v)}>Edit</button>
                        <button onClick={() => openNotes(v)}>Notes</button>
                        <button onClick={() => openBlocks(v)}>Blocks</button>
                        {v.status !== "retired" && <button className="danger" onClick={() => retire(v)}>Retire</button>}
                      </div></td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditId(null); setF({ ...empty }); }}
        title={editId ? "Edit vehicle" : "Add vehicle"}
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
            <label>Price / day (USD)<input type="number" step="0.01" min="0" required value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} /></label>
            <label>Price / week (USD)<input type="number" step="0.01" min="0" required value={f.week} onChange={(e) => setF({ ...f, week: e.target.value })} /></label>
            <label>Price / month (USD)<input type="number" step="0.01" min="0" required value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} /></label>
            <label>Deposit (USD, blank = TBC)<input type="number" step="0.01" min="0" value={f.deposit} onChange={(e) => setF({ ...f, deposit: e.target.value })} /></label>
            <label>Insurance expires<DatePicker value={f.insurance} onChange={(iso) => setF({ ...f, insurance: iso })} ariaLabel="Insurance expires" placeholder="Not tracked" /></label>
            <label>Inspection due<DatePicker value={f.inspection} onChange={(iso) => setF({ ...f, inspection: iso })} ariaLabel="Inspection due" placeholder="Not tracked" /></label>
            <label>Status<Select value={f.status} onChange={(v) => setF({ ...f, status: v })} options={[{ value: "active", label: "active" }, { value: "maintenance", label: "maintenance" }, { value: "retired", label: "retired" }]} /></label>
            <label className="check fleet-check"><input type="checkbox" checked={f.ac} onChange={(e) => setF({ ...f, ac: e.target.checked })} /> Air conditioning</label>
          </div>
        </form>
      </Modal>

      <Drawer
        open={blocksFor !== null}
        onClose={() => setBlocksFor(null)}
        title="Availability blocks"
        description={blocksFor ? blocksFor.name : undefined}
        size="md"
        footer={
          <button type="button" className="btn btn--quiet" onClick={() => setBlocksFor(null)}>Close</button>
        }
      >
        <table className="grid fleet-blocks-grid">
          <thead><tr><th>From</th><th>Until</th><th>Type</th><th>Reason</th><th></th></tr></thead>
          <tbody>
            {blocks.length === 0 && <tr><td colSpan={5} className="muted">No blocks.</td></tr>}
            {blocks.map((b) => (
              <tr key={b.id}><td>{b.startDate}</td><td>{b.endDate}</td><td>{b.type.replace(/_/g, " ")}</td><td>{b.reason || "None"}</td>
                <td><div className="row-actions"><button className="danger" onClick={() => removeBlock(b.id)}>Delete</button></div></td></tr>
            ))}
          </tbody>
        </table>
        <form className="inline-form fleet-block-form" onSubmit={addBlock}>
          <label>From<br /><DatePicker value={bo.startDate} onChange={(iso) => setBo({ ...bo, startDate: iso })} required /></label>
          <label>Start time<br /><TimeSelect value={bo.startTime} onChange={(t) => setBo({ ...bo, startTime: t })} /></label>
          <label>Until<br /><DatePicker value={bo.endDate} onChange={(iso) => setBo({ ...bo, endDate: iso })} required /></label>
          <label>End time<br /><TimeSelect value={bo.endTime} onChange={(t) => setBo({ ...bo, endTime: t })} /></label>
          <label>Type<br /><Select value={bo.type} onChange={(v) => setBo({ ...bo, type: v })} options={BLOCK_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, " ") }))} /></label>
          <label>Reason<br /><input value={bo.reason} onChange={(e) => setBo({ ...bo, reason: e.target.value })} /></label>
          <button className="btn" style={{ width: "auto" }}>Add block</button>
        </form>
        <p className="muted fleet-block-hint">Leave 00:00 for full days.</p>
      </Drawer>

      <Drawer
        open={notesFor !== null}
        onClose={() => setNotesFor(null)}
        title="Notes"
        description={notesFor ? `${notesFor.plate} · ${notesFor.name}` : undefined}
        size="md"
        footer={<button type="button" className="btn btn--quiet" onClick={() => setNotesFor(null)}>Close</button>}
      >
        <form className="inline-form fleet-note-form" onSubmit={addNote}>
          <label>New note<br />
            <input data-autofocus required maxLength={500} value={noteBody} onChange={(e) => setNoteBody(e.target.value)} placeholder="e.g. customer says brakes feel soft" />
          </label>
          <button className="btn" style={{ width: "auto" }}>Add note</button>
        </form>
        {notes.length === 0 ? (
          <p className="muted">No notes for this car yet. Complaints and future maintenance go here.</p>
        ) : (
          <ul className="fleet-notes">
            {notes.map((n) => (
              <li key={n.id} className={`fleet-note ${n.resolvedAt ? "is-resolved" : ""}`}>
                <p className="fleet-note__body">{n.body}</p>
                <div className="fleet-note__meta">
                  <span>{new Date(n.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                  {n.resolvedAt ? <span className="tag on">resolved</span> : <span className="tag def">open</span>}
                </div>
                <div className="row-actions">
                  {n.resolvedAt === null ? (
                    <>
                      <button onClick={() => resolveNote(n, true)}>Resolve</button>
                      <button onClick={() => escalateNote(n)}>Block car for this</button>
                    </>
                  ) : (
                    <button onClick={() => resolveNote(n, false)}>Reopen</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Drawer>
    </>
  );
}
