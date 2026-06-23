"use client";

import { useEffect, useState, type FormEvent } from "react";
import { apiGet, api, apiPatch, apiDelete, type ApiError } from "../../client";

interface AddOn { id: string; name: string; description: string; priceCents: number; pricing: "per_day" | "per_rental"; category: string; stock: number | null; active: boolean }
interface Tier { id: string; name: string; dailyPriceCents: number; coverage: string; isDefault: boolean; active: boolean }

const emptyAddOn = { name: "", description: "", price: "", pricing: "per_rental", category: "equipment", stock: "", active: true };
const emptyTier = { name: "", price: "", coverage: "", isDefault: false, active: true };

export default function CatalogPage() {
  const [addons, setAddons] = useState<AddOn[]>([]);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [a, setA] = useState({ ...emptyAddOn });
  const [aId, setAId] = useState<string | null>(null);
  const [t, setT] = useState({ ...emptyTier });
  const [tId, setTId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  async function load() {
    setAddons(await apiGet<AddOn[]>("/api/admin/addons"));
    setTiers(await apiGet<Tier[]>("/api/admin/insurance"));
  }
  useEffect(() => { void load(); }, []);

  async function saveAddOn(e: FormEvent) {
    e.preventDefault(); setMsg("");
    const body = {
      name: a.name, description: a.description, priceCents: Math.round(Number(a.price) * 100),
      pricing: a.pricing, category: a.category,
      stock: a.stock === "" ? null : Number(a.stock), active: a.active,
    };
    try {
      if (aId) await apiPatch(`/api/admin/addons/${aId}`, body);
      else await api("/api/admin/addons", body);
      setA({ ...emptyAddOn }); setAId(null); await load();
    } catch (err) { setMsg((err as ApiError).message); }
  }

  async function saveTier(e: FormEvent) {
    e.preventDefault(); setMsg("");
    const body = { name: t.name, dailyPriceCents: Math.round(Number(t.price) * 100), coverage: t.coverage, isDefault: t.isDefault, active: t.active };
    try {
      if (tId) await apiPatch(`/api/admin/insurance/${tId}`, body);
      else await api("/api/admin/insurance", body);
      setT({ ...emptyTier }); setTId(null); await load();
    } catch (err) { setMsg((err as ApiError).message); }
  }

  const editAddOn = (x: AddOn) => { setAId(x.id); setA({ name: x.name, description: x.description, price: (x.priceCents / 100).toString(), pricing: x.pricing, category: x.category, stock: x.stock === null ? "" : x.stock.toString(), active: x.active }); };
  const editTier = (x: Tier) => { setTId(x.id); setT({ name: x.name, price: (x.dailyPriceCents / 100).toString(), coverage: x.coverage, isDefault: x.isDefault, active: x.active }); };
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;

  return (
    <>
      <h1>Add-ons &amp; insurance</h1>
      <p className="sub">Extras and insurance tiers offered in the booking flow.</p>

      <div className="panel">
        <h2>Add-ons</h2>
        <table className="grid">
          <thead><tr><th>Name</th><th>Category</th><th className="num">Price</th><th>Per</th><th className="num">Stock</th><th>Active</th><th></th></tr></thead>
          <tbody>
            {addons.length === 0 && <tr><td colSpan={7} className="muted">None yet.</td></tr>}
            {addons.map((x) => (
              <tr key={x.id}>
                <td>{x.name}</td><td>{x.category}</td><td className="num">{money(x.priceCents)}</td>
                <td>{x.pricing === "per_day" ? "day" : "rental"}</td>
                <td className="num">{x.stock ?? "∞"}</td>
                <td><span className={`tag ${x.active ? "on" : "off"}`}>{x.active ? "active" : "off"}</span></td>
                <td><div className="row-actions"><button onClick={() => editAddOn(x)}>Edit</button><button className="danger" onClick={async () => { await apiDelete(`/api/admin/addons/${x.id}`); await load(); }}>Delete</button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="form-grid" style={{ marginTop: "1rem" }} onSubmit={saveAddOn}>
          <label>Name<input required value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} /></label>
          <label>Category<input value={a.category} onChange={(e) => setA({ ...a, category: e.target.value })} /></label>
          <label>Price (USD)<input type="number" step="0.01" min="0" required value={a.price} onChange={(e) => setA({ ...a, price: e.target.value })} /></label>
          <label>Charged<select value={a.pricing} onChange={(e) => setA({ ...a, pricing: e.target.value })}><option value="per_rental">per rental</option><option value="per_day">per day</option></select></label>
          <label>Stock (blank = unlimited)<input type="number" min="0" value={a.stock} onChange={(e) => setA({ ...a, stock: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={a.active} onChange={(e) => setA({ ...a, active: e.target.checked })} /> Active</label>
          <label className="full">Description<input value={a.description} onChange={(e) => setA({ ...a, description: e.target.value })} /></label>
          <div className="actions full">
            <button className="btn">{aId ? "Update add-on" : "Add add-on"}</button>
            {aId && <button type="button" className="btn btn--quiet" onClick={() => { setAId(null); setA({ ...emptyAddOn }); }}>Cancel</button>}
          </div>
        </form>
      </div>

      <div className="panel">
        <h2>Insurance tiers</h2>
        <table className="grid">
          <thead><tr><th>Name</th><th className="num">Per day</th><th>Coverage</th><th>Default</th><th>Active</th><th></th></tr></thead>
          <tbody>
            {tiers.length === 0 && <tr><td colSpan={6} className="muted">None yet.</td></tr>}
            {tiers.map((x) => (
              <tr key={x.id}>
                <td>{x.name}</td><td className="num">{money(x.dailyPriceCents)}</td><td className="muted">{x.coverage || "—"}</td>
                <td>{x.isDefault ? <span className="tag def">default</span> : ""}</td>
                <td><span className={`tag ${x.active ? "on" : "off"}`}>{x.active ? "active" : "off"}</span></td>
                <td><div className="row-actions"><button onClick={() => editTier(x)}>Edit</button><button className="danger" onClick={async () => { await apiDelete(`/api/admin/insurance/${x.id}`); await load(); }}>Delete</button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="form-grid" style={{ marginTop: "1rem" }} onSubmit={saveTier}>
          <label>Name<input required value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></label>
          <label>Price per day (USD)<input type="number" step="0.01" min="0" required value={t.price} onChange={(e) => setT({ ...t, price: e.target.value })} /></label>
          <label className="full">Coverage description<input value={t.coverage} onChange={(e) => setT({ ...t, coverage: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={t.isDefault} onChange={(e) => setT({ ...t, isDefault: e.target.checked })} /> Default tier</label>
          <label className="check"><input type="checkbox" checked={t.active} onChange={(e) => setT({ ...t, active: e.target.checked })} /> Active</label>
          <div className="actions full">
            <button className="btn">{tId ? "Update tier" : "Add tier"}</button>
            {tId && <button type="button" className="btn btn--quiet" onClick={() => { setTId(null); setT({ ...emptyTier }); }}>Cancel</button>}
          </div>
        </form>
      </div>
      <p className="muted">{msg}</p>
    </>
  );
}
