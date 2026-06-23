"use client";

import { useEffect, useState, type FormEvent } from "react";
import { apiGet, api, apiPatch, apiDelete, type ApiError } from "../../client";

interface Vehicle {
  id: string; slug: string; plate: string; class: string; name: string; seats: number;
  transmission: "Automatic" | "Manual"; ac: boolean; doors: number; photos: string[];
  priceDayCents: number; priceWeekCents: number; priceMonthCents: number;
  depositCents: number | null; status: "active" | "maintenance" | "retired";
}
interface Block { id: string; startDate: string; endDate: string; type: string; reason: string }

const CLASSES = ["Economy", "Compact", "SUV", "4x4", "Van"];
const BLOCK_TYPES = ["maintenance", "carwash", "cleaning", "out_of_service", "other"];
const empty = {
  slug: "", plate: "", class: "Economy", name: "", seats: "5", transmission: "Automatic",
  ac: true, doors: "4", day: "", week: "", month: "", deposit: "", status: "active",
};

export default function FleetPage() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [f, setF] = useState({ ...empty });
  const [editId, setEditId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [blocksFor, setBlocksFor] = useState<Vehicle | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [bo, setBo] = useState({ startDate: "", endDate: "", type: "maintenance", reason: "" });

  async function load() { setVehicles(await apiGet<Vehicle[]>("/api/admin/vehicles")); }
  useEffect(() => { void load(); }, []);

  async function save(e: FormEvent) {
    e.preventDefault(); setMsg("");
    const body = {
      slug: f.slug, plate: f.plate, class: f.class, name: f.name, seats: Number(f.seats),
      transmission: f.transmission, ac: f.ac, doors: Number(f.doors),
      priceDayCents: Math.round(Number(f.day) * 100),
      priceWeekCents: Math.round(Number(f.week) * 100),
      priceMonthCents: Math.round(Number(f.month) * 100),
      depositCents: f.deposit === "" ? null : Math.round(Number(f.deposit) * 100),
      status: f.status,
    };
    try {
      if (editId) await apiPatch(`/api/admin/vehicles/${editId}`, body);
      else await api("/api/admin/vehicles", body);
      setF({ ...empty }); setEditId(null); await load();
      setMsg("Saved.");
    } catch (err) { setMsg((err as ApiError).message); }
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
    });
  }

  async function openBlocks(v: Vehicle) {
    setBlocksFor(v);
    setBlocks(await apiGet<Block[]>(`/api/admin/vehicles/${v.id}/blocks`));
  }
  async function addBlock(e: FormEvent) {
    e.preventDefault();
    if (!blocksFor) return;
    try {
      await api(`/api/admin/vehicles/${blocksFor.id}/blocks`, bo);
      setBo({ startDate: "", endDate: "", type: "maintenance", reason: "" });
      setBlocks(await apiGet<Block[]>(`/api/admin/vehicles/${blocksFor.id}/blocks`));
    } catch (err) { setMsg((err as ApiError).message); }
  }
  async function removeBlock(id: string) {
    await apiDelete(`/api/admin/blocks/${id}`);
    if (blocksFor) setBlocks(await apiGet<Block[]>(`/api/admin/vehicles/${blocksFor.id}/blocks`));
  }

  const money = (c: number) => `$${(c / 100).toFixed(0)}`;

  return (
    <>
      <h1>Fleet &amp; pricing</h1>
      <p className="sub">The vehicles, rates, and deposits offered online. Retiring keeps booking history; it just hides the car.</p>

      <div className="panel">
        <h2>Vehicles</h2>
        <table className="grid">
          <thead><tr><th>Plate</th><th>Name</th><th>Class</th><th className="num">Day</th><th className="num">Week</th><th className="num">Month</th><th className="num">Deposit</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {vehicles.length === 0 && <tr><td colSpan={9} className="muted">No vehicles yet.</td></tr>}
            {vehicles.map((v) => (
              <tr key={v.id}>
                <td><b>{v.plate}</b></td>
                <td>{v.name}<div className="muted">{v.slug}</div></td>
                <td>{v.class}</td>
                <td className="num">{money(v.priceDayCents)}</td>
                <td className="num">{money(v.priceWeekCents)}</td>
                <td className="num">{money(v.priceMonthCents)}</td>
                <td className="num">{v.depositCents === null ? "—" : money(v.depositCents)}</td>
                <td><span className={`tag ${v.status === "active" ? "on" : v.status === "retired" ? "off" : ""}`}>{v.status}</span></td>
                <td><div className="row-actions">
                  <button onClick={() => edit(v)}>Edit</button>
                  <button onClick={() => openBlocks(v)}>Blocks</button>
                  {v.status !== "retired" && <button className="danger" onClick={async () => { await apiDelete(`/api/admin/vehicles/${v.id}`); await load(); }}>Retire</button>}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="panel" onSubmit={save}>
        <h2>{editId ? "Edit vehicle" : "Add vehicle"}</h2>
        <div className="form-grid">
          <label>Name<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label>Plate (registration / row ID)<input required value={f.plate} onChange={(e) => setF({ ...f, plate: e.target.value })} placeholder="A-1234" /></label>
          <label>Slug (kebab-case)<input required value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} placeholder="kia-picanto" /></label>
          <label>Class<select value={f.class} onChange={(e) => setF({ ...f, class: e.target.value })}>{CLASSES.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label>Transmission<select value={f.transmission} onChange={(e) => setF({ ...f, transmission: e.target.value })}><option>Automatic</option><option>Manual</option></select></label>
          <label>Seats<input type="number" min="1" max="20" value={f.seats} onChange={(e) => setF({ ...f, seats: e.target.value })} /></label>
          <label>Doors<input type="number" min="1" max="8" value={f.doors} onChange={(e) => setF({ ...f, doors: e.target.value })} /></label>
          <label>Price / day (USD)<input type="number" step="0.01" min="0" required value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} /></label>
          <label>Price / week (USD)<input type="number" step="0.01" min="0" required value={f.week} onChange={(e) => setF({ ...f, week: e.target.value })} /></label>
          <label>Price / month (USD)<input type="number" step="0.01" min="0" required value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} /></label>
          <label>Deposit (USD, blank = TBC)<input type="number" step="0.01" min="0" value={f.deposit} onChange={(e) => setF({ ...f, deposit: e.target.value })} /></label>
          <label>Status<select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="active">active</option><option value="maintenance">maintenance</option><option value="retired">retired</option></select></label>
          <label className="check"><input type="checkbox" checked={f.ac} onChange={(e) => setF({ ...f, ac: e.target.checked })} /> Air conditioning</label>
        </div>
        <div className="actions">
          <button className="btn">{editId ? "Update vehicle" : "Add vehicle"}</button>
          {editId && <button type="button" className="btn btn--quiet" onClick={() => { setEditId(null); setF({ ...empty }); }}>Cancel</button>}
          <span className="muted">{msg}</span>
        </div>
      </form>

      {blocksFor && (
        <div className="panel">
          <h2>Availability blocks <span className="v">{blocksFor.name}</span></h2>
          <table className="grid">
            <thead><tr><th>From</th><th>Until</th><th>Type</th><th>Reason</th><th></th></tr></thead>
            <tbody>
              {blocks.length === 0 && <tr><td colSpan={5} className="muted">No blocks.</td></tr>}
              {blocks.map((b) => (
                <tr key={b.id}><td>{b.startDate}</td><td>{b.endDate}</td><td>{b.type.replace(/_/g, " ")}</td><td>{b.reason || "—"}</td>
                  <td><div className="row-actions"><button className="danger" onClick={() => removeBlock(b.id)}>Delete</button></div></td></tr>
              ))}
            </tbody>
          </table>
          <form className="inline-form" style={{ marginTop: "1rem" }} onSubmit={addBlock}>
            <label>From<br /><input type="date" required value={bo.startDate} onChange={(e) => setBo({ ...bo, startDate: e.target.value })} /></label>
            <label>Until<br /><input type="date" required value={bo.endDate} onChange={(e) => setBo({ ...bo, endDate: e.target.value })} /></label>
            <label>Type<br /><select value={bo.type} onChange={(e) => setBo({ ...bo, type: e.target.value })}>{BLOCK_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}</select></label>
            <label>Reason<br /><input value={bo.reason} onChange={(e) => setBo({ ...bo, reason: e.target.value })} /></label>
            <button className="btn" style={{ width: "auto" }}>Add block</button>
            <button type="button" className="btn btn--quiet" onClick={() => setBlocksFor(null)}>Close</button>
          </form>
        </div>
      )}
    </>
  );
}
