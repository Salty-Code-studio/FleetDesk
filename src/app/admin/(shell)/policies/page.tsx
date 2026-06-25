"use client";

import { useEffect, useState } from "react";
import { apiGet, api, type ApiError } from "../../client";
import {
  Drawer,
  Skeleton,
  EmptyState,
  useToast,
  registerPaletteAction,
} from "@/app/admin/_ui";
import "./policies.css";

type PolicyType = "rental_terms" | "cancellation" | "privacy";
interface Overview {
  type: PolicyType;
  latest: { version: number; body: string; publishedAt: string | null } | null;
  versionCount: number;
}

const LABELS: Record<PolicyType, string> = {
  rental_terms: "Rental terms",
  cancellation: "Cancellation & refund",
  privacy: "Privacy policy",
};

const HINTS: Record<PolicyType, string> = {
  rental_terms: "The agreement a renter accepts at checkout.",
  cancellation: "How refunds and cancellations work for a booking.",
  privacy: "How customer data is collected and used.",
};

export default function PoliciesPage() {
  const [items, setItems] = useState<Overview[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editType, setEditType] = useState<PolicyType | null>(null);

  const toast = useToast();

  async function load() {
    const data = await apiGet<Overview[]>("/api/admin/policies");
    setItems(data);
    setDrafts(Object.fromEntries(data.map((d) => [d.type, d.latest?.body ?? ""])));
  }
  useEffect(() => { void load().finally(() => setLoading(false)); }, []);

  function openEdit(type: PolicyType) {
    setMsg((m) => ({ ...m, [type]: "" }));
    setEditType(type);
  }
  function closeEdit() {
    setEditType(null);
    setSaving(false);
  }

  // Page-scoped command-palette action: jump straight to editing rental terms.
  useEffect(
    () =>
      registerPaletteAction({
        id: "policies-edit-terms",
        label: "Edit rental terms",
        hint: "Policies",
        keywords: "policy policies terms rental publish edit",
        run: () => openEdit("rental_terms"),
      }),
    [],
  );

  async function publish(type: PolicyType) {
    setSaving(true);
    setMsg((m) => ({ ...m, [type]: "" }));
    try {
      await api("/api/admin/policies", { type, body: drafts[type] ?? "" });
      await load();
      setEditType(null);
      toast.show({ type: "success", message: `${LABELS[type]} published a new version.` });
    } catch (err) {
      setMsg((m) => ({ ...m, [type]: (err as ApiError).message }));
      toast.show({ type: "error", message: (err as ApiError).message });
    } finally {
      setSaving(false);
    }
  }

  const editing = editType ? items.find((p) => p.type === editType) ?? null : null;

  return (
    <>
      <header className="pol-head">
        <div className="pol-head__lead">
          <h1>Policies</h1>
          <p className="sub">Each save publishes a new immutable version. Older versions are kept; bookings record the version the customer accepted.</p>
        </div>
      </header>

      {loading ? (
        <div className="pol-list">
          {Array.from({ length: 3 }).map((_, i) => (
            <div className="panel pol-card" key={i} aria-busy="true">
              <div className="pol-card__head">
                <div className="pol-card__title">
                  <Skeleton width="42%" height={18} />
                  <Skeleton width={70} height={11} radius={6} style={{ marginTop: ".5rem" }} />
                </div>
                <Skeleton width={92} height={34} radius={9} />
              </div>
              <Skeleton width="100%" height={12} style={{ marginTop: ".4rem" }} />
              <Skeleton width="85%" height={12} style={{ marginTop: ".55rem" }} />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="No policies configured"
          hint="Policy types appear here once the catalog is set up. Try reloading."
        />
      ) : (
        <div className="pol-list">
          {items.map((p) => (
            <div className="panel pol-card" key={p.type}>
              <div className="pol-card__head">
                <div className="pol-card__title">
                  <h2>{LABELS[p.type]}</h2>
                  <span className={`tag ${p.latest ? "on" : "def"}`}>
                    {p.latest ? `v${p.latest.version}` : "Not published"}
                    {p.versionCount > 0 ? ` · ${p.versionCount} version${p.versionCount > 1 ? "s" : ""}` : ""}
                  </span>
                </div>
                <button type="button" className="btn btn--accent pol-edit-btn" onClick={() => openEdit(p.type)}>
                  {p.latest ? "Edit" : "Write"}
                </button>
              </div>
              <p className="pol-card__hint">{HINTS[p.type]}</p>
              {p.latest ? (
                <p className="pol-card__preview">{previewOf(drafts[p.type] ?? p.latest.body)}</p>
              ) : (
                <p className="pol-card__preview pol-card__preview--empty">No version published yet. Write the first one.</p>
              )}
            </div>
          ))}
        </div>
      )}

      <Drawer
        open={editType !== null}
        onClose={closeEdit}
        title={editing ? LABELS[editing.type] : "Policy"}
        description={editing ? `${editing.latest ? `Current v${editing.latest.version}.` : "Not published yet."} Each save publishes a new immutable version.` : undefined}
        size="lg"
        footer={
          editType ? (
            <>
              {msg[editType] ? <span className="pol-error">{msg[editType]}</span> : null}
              <button type="button" className="btn btn--quiet" onClick={closeEdit}>Cancel</button>
              <button type="button" className="btn btn--accent" disabled={saving} onClick={() => publish(editType)}>
                {saving ? "Publishing…" : "Publish new version"}
              </button>
            </>
          ) : null
        }
      >
        {editType ? (
          <div className="form-grid">
            <label className="full">Body (Markdown)
              <textarea
                data-autofocus
                className="pol-textarea"
                value={drafts[editType] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [editType]: e.target.value }))}
              />
            </label>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}

/** Short single-line preview of a policy body for the card. */
function previewOf(body: string): string {
  const clean = body.replace(/\s+/g, " ").trim();
  if (!clean) return "Empty draft.";
  return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
}
