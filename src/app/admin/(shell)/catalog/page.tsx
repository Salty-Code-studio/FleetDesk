"use client";

import { useEffect, useState, type FormEvent } from "react";
import { apiGet, api, apiPatch, apiDelete, type ApiError } from "../../client";
import {
  Modal,
  Skeleton,
  EmptyState,
  useToast,
  useConfirm,
  registerPaletteAction,
} from "@/app/admin/_ui";
import { Select } from "@/components/ui";
import "./catalog.css";

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
  const [loading, setLoading] = useState(true);
  const [addOnOpen, setAddOnOpen] = useState(false);
  const [tierOpen, setTierOpen] = useState(false);

  const toast = useToast();
  const confirm = useConfirm();

  async function load() {
    setAddons(await apiGet<AddOn[]>("/api/admin/addons"));
    setTiers(await apiGet<Tier[]>("/api/admin/insurance"));
  }
  useEffect(() => { void load().finally(() => setLoading(false)); }, []);

  function openAddOn() {
    setAId(null);
    setA({ ...emptyAddOn });
    setAddOnOpen(true);
  }
  function closeAddOn() {
    setAddOnOpen(false);
    setAId(null);
    setA({ ...emptyAddOn });
  }
  function openTier() {
    setTId(null);
    setT({ ...emptyTier });
    setTierOpen(true);
  }
  function closeTier() {
    setTierOpen(false);
    setTId(null);
    setT({ ...emptyTier });
  }

  // Page-scoped command-palette actions.
  useEffect(
    () =>
      registerPaletteAction({
        id: "catalog-add-addon",
        label: "Add add-on",
        hint: "Catalog",
        keywords: "addon add-on extra equipment catalog",
        run: () => openAddOn(),
      }),
    [],
  );
  useEffect(
    () =>
      registerPaletteAction({
        id: "catalog-add-tier",
        label: "Add insurance tier",
        hint: "Catalog",
        keywords: "insurance tier coverage cover catalog",
        run: () => openTier(),
      }),
    [],
  );

  async function saveAddOn(e: FormEvent) {
    e.preventDefault();
    const body = {
      name: a.name, description: a.description, priceCents: Math.round(Number(a.price) * 100),
      pricing: a.pricing, category: a.category,
      stock: a.stock === "" ? null : Number(a.stock), active: a.active,
    };
    try {
      const wasEdit = aId !== null;
      if (aId) await apiPatch(`/api/admin/addons/${aId}`, body);
      else await api("/api/admin/addons", body);
      setA({ ...emptyAddOn }); setAId(null); await load();
      setAddOnOpen(false);
      toast.show({ type: "success", message: wasEdit ? "Add-on updated." : "Add-on created." });
    } catch (err) { toast.show({ type: "error", message: (err as ApiError).message }); }
  }

  async function saveTier(e: FormEvent) {
    e.preventDefault();
    const body = { name: t.name, dailyPriceCents: Math.round(Number(t.price) * 100), coverage: t.coverage, isDefault: t.isDefault, active: t.active };
    try {
      const wasEdit = tId !== null;
      if (tId) await apiPatch(`/api/admin/insurance/${tId}`, body);
      else await api("/api/admin/insurance", body);
      setT({ ...emptyTier }); setTId(null); await load();
      setTierOpen(false);
      toast.show({ type: "success", message: wasEdit ? "Tier updated." : "Tier created." });
    } catch (err) { toast.show({ type: "error", message: (err as ApiError).message }); }
  }

  const editAddOn = (x: AddOn) => { setAId(x.id); setA({ name: x.name, description: x.description, price: (x.priceCents / 100).toString(), pricing: x.pricing, category: x.category, stock: x.stock === null ? "" : x.stock.toString(), active: x.active }); setAddOnOpen(true); };
  const editTier = (x: Tier) => { setTId(x.id); setT({ name: x.name, price: (x.dailyPriceCents / 100).toString(), coverage: x.coverage, isDefault: x.isDefault, active: x.active }); setTierOpen(true); };

  async function deleteAddOn(x: AddOn) {
    const ok = await confirm({
      title: "Delete this add-on?",
      message: `${x.name} will no longer appear as an extra in the booking flow.`,
      confirmLabel: "Delete add-on",
      danger: true,
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/admin/addons/${x.id}`);
      await load();
      toast.show({ type: "success", message: "Add-on deleted." });
    } catch (err) { toast.show({ type: "error", message: (err as ApiError).message }); }
  }

  async function deleteTier(x: Tier) {
    const ok = await confirm({
      title: "Delete this insurance tier?",
      message: `${x.name} will no longer be offered at checkout.`,
      confirmLabel: "Delete tier",
      danger: true,
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/admin/insurance/${x.id}`);
      await load();
      toast.show({ type: "success", message: "Tier deleted." });
    } catch (err) { toast.show({ type: "error", message: (err as ApiError).message }); }
  }

  const money = (c: number) => `$${(c / 100).toFixed(2)}`;

  return (
    <>
      <header className="cat-head">
        <div className="cat-head__lead">
          <h1>Add-ons &amp; insurance</h1>
          <p className="sub">Extras and insurance tiers offered in the booking flow.</p>
        </div>
      </header>

      <div className="panel">
        <div className="cat-panel-head">
          <h2>Add-ons</h2>
          <div className="cat-panel-head__right">
            {!loading && addons.length > 0 && (
              <span className="cat-count">{addons.length} total</span>
            )}
            <button type="button" className="btn btn--accent" onClick={openAddOn}>Add add-on</button>
          </div>
        </div>

        {loading ? (
          <table className="grid cat-grid" aria-busy="true">
            <thead><tr><th>Name</th><th>Category</th><th className="num">Price</th><th>Per</th><th className="num">Stock</th><th>Active</th><th></th></tr></thead>
            <tbody>
              {Array.from({ length: 3 }).map((_, r) => (
                <tr key={r}>
                  <td><Skeleton width="70%" /></td>
                  <td><Skeleton width="55%" /></td>
                  <td className="num"><Skeleton width="40%" /></td>
                  <td><Skeleton width="45%" /></td>
                  <td className="num"><Skeleton width="30%" /></td>
                  <td><Skeleton width={56} radius={6} /></td>
                  <td><Skeleton width="70%" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : addons.length === 0 ? (
          <EmptyState
            title="No add-ons yet"
            hint="Create your first extra so renters can book equipment and services."
            action={<button type="button" className="btn btn--accent" onClick={openAddOn}>Add add-on</button>}
          />
        ) : (
          <table className="grid cat-grid">
            <thead><tr><th>Name</th><th>Category</th><th className="num">Price</th><th>Per</th><th className="num">Stock</th><th>Active</th><th></th></tr></thead>
            <tbody>
              {addons.map((x) => (
                <tr key={x.id}>
                  <td>{x.name}{x.description ? <div className="cat-sub">{x.description}</div> : null}</td>
                  <td>{x.category}</td>
                  <td className="num">{money(x.priceCents)}</td>
                  <td>{x.pricing === "per_day" ? "day" : "rental"}</td>
                  <td className="num">{x.stock ?? "Unlimited"}</td>
                  <td><span className={`tag ${x.active ? "on" : "off"}`}>{x.active ? "active" : "off"}</span></td>
                  <td className="cat-actions"><div className="row-actions">
                    <button onClick={() => editAddOn(x)}>Edit</button>
                    <button className="danger" onClick={() => deleteAddOn(x)}>Delete</button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={addOnOpen}
        onClose={closeAddOn}
        title={aId ? "Edit add-on" : "Add add-on"}
        description="Extras shown in the booking flow. Rates are in USD. Leave stock blank for unlimited."
        size="lg"
        footer={
          <>
            <button type="button" className="btn btn--quiet" onClick={closeAddOn}>Cancel</button>
            <button type="submit" form="catalog-addon-form" className="btn btn--accent">{aId ? "Update add-on" : "Add add-on"}</button>
          </>
        }
      >
        <form id="catalog-addon-form" onSubmit={saveAddOn}>
          <div className="form-grid">
            <label>Name<input data-autofocus required value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} /></label>
            <label>Category<input value={a.category} onChange={(e) => setA({ ...a, category: e.target.value })} /></label>
            <label>Price (USD)<input type="number" step="0.01" min="0" required value={a.price} onChange={(e) => setA({ ...a, price: e.target.value })} /></label>
            <label>Charged<Select value={a.pricing} onChange={(value) => setA({ ...a, pricing: value })} options={[{ value: "per_rental", label: "per rental" }, { value: "per_day", label: "per day" }]} ariaLabel="Charged" /></label>
            <label>Stock (blank = unlimited)<input type="number" min="0" value={a.stock} onChange={(e) => setA({ ...a, stock: e.target.value })} /></label>
            <label className="check"><input type="checkbox" checked={a.active} onChange={(e) => setA({ ...a, active: e.target.checked })} /> Active</label>
            <label className="full">Description<input value={a.description} onChange={(e) => setA({ ...a, description: e.target.value })} /></label>
          </div>
        </form>
      </Modal>

      <div className="panel">
        <div className="cat-panel-head">
          <h2>Insurance tiers</h2>
          <div className="cat-panel-head__right">
            {!loading && tiers.length > 0 && (
              <span className="cat-count">{tiers.length} total</span>
            )}
            <button type="button" className="btn btn--quiet" onClick={openTier}>Add tier</button>
          </div>
        </div>

        {loading ? (
          <table className="grid cat-grid" aria-busy="true">
            <thead><tr><th>Name</th><th className="num">Per day</th><th>Coverage</th><th>Default</th><th>Active</th><th></th></tr></thead>
            <tbody>
              {Array.from({ length: 3 }).map((_, r) => (
                <tr key={r}>
                  <td><Skeleton width="55%" /></td>
                  <td className="num"><Skeleton width="40%" /></td>
                  <td><Skeleton width="80%" /></td>
                  <td><Skeleton width={56} radius={6} /></td>
                  <td><Skeleton width={56} radius={6} /></td>
                  <td><Skeleton width="70%" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : tiers.length === 0 ? (
          <EmptyState
            title="No insurance tiers yet"
            hint="Add a tier so renters can choose their level of cover at checkout."
            action={<button type="button" className="btn btn--quiet" onClick={openTier}>Add tier</button>}
          />
        ) : (
          <table className="grid cat-grid">
            <thead><tr><th>Name</th><th className="num">Per day</th><th>Coverage</th><th>Default</th><th>Active</th><th></th></tr></thead>
            <tbody>
              {tiers.map((x) => (
                <tr key={x.id}>
                  <td>{x.name}</td>
                  <td className="num">{money(x.dailyPriceCents)}</td>
                  <td className="muted">{x.coverage || "None"}</td>
                  <td>{x.isDefault ? <span className="tag def">default</span> : <span className="cat-dash">None</span>}</td>
                  <td><span className={`tag ${x.active ? "on" : "off"}`}>{x.active ? "active" : "off"}</span></td>
                  <td className="cat-actions"><div className="row-actions">
                    <button onClick={() => editTier(x)}>Edit</button>
                    <button className="danger" onClick={() => deleteTier(x)}>Delete</button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={tierOpen}
        onClose={closeTier}
        title={tId ? "Edit insurance tier" : "Add insurance tier"}
        description="Cover levels offered at checkout. Promoting a tier to default unsets the previous one."
        size="md"
        footer={
          <>
            <button type="button" className="btn btn--quiet" onClick={closeTier}>Cancel</button>
            <button type="submit" form="catalog-tier-form" className="btn btn--accent">{tId ? "Update tier" : "Add tier"}</button>
          </>
        }
      >
        <form id="catalog-tier-form" onSubmit={saveTier}>
          <div className="form-grid">
            <label>Name<input data-autofocus required value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></label>
            <label>Price per day (USD)<input type="number" step="0.01" min="0" required value={t.price} onChange={(e) => setT({ ...t, price: e.target.value })} /></label>
            <label className="full">Coverage description<input value={t.coverage} onChange={(e) => setT({ ...t, coverage: e.target.value })} /></label>
            <label className="check"><input type="checkbox" checked={t.isDefault} onChange={(e) => setT({ ...t, isDefault: e.target.checked })} /> Default tier</label>
            <label className="check"><input type="checkbox" checked={t.active} onChange={(e) => setT({ ...t, active: e.target.checked })} /> Active</label>
          </div>
        </form>
      </Modal>
    </>
  );
}
