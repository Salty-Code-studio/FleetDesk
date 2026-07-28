"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, apiGet, apiPatch, type ApiError } from "../../client";
import { Modal, Skeleton, EmptyState, useConfirm, useToast } from "@/app/admin/_ui";
import "./staff.css";

interface StaffRow { id: string; name: string | null; active: boolean; createdAt: string }
interface LoginRow { id: string; actorLabel: string; createdAt: string }
interface CodeReveal { name: string; code: string }

export default function StaffPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [logins, setLogins] = useState<LoginRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<CodeReveal | null>(null);

  const load = useCallback(async () => {
    try {
      const [roster, loginRows] = await Promise.all([
        apiGet<{ staff: StaffRow[] }>("/api/admin/staff"),
        apiGet<LoginRow[]>("/api/admin/audit?limit=15&action=admin.login"),
      ]);
      setStaff(roster.staff);
      setLogins(loginRows);
    } catch (err) {
      if ((err as ApiError).status === 403) setForbidden(true);
      else toast.show({ type: "error", message: (err as ApiError).message });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const created = await api<{ id: string; name: string; code: string }>(
        "/api/admin/staff", { name: trimmed },
      );
      setName("");
      setReveal({ name: created.name, code: created.code });
      await load();
    } catch (err) {
      toast.show({ type: "error", message: (err as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  async function onRegenerate(row: StaffRow) {
    const ok = await confirm({
      title: "Regenerate login code?",
      message: `${row.name ?? "This staff member"} gets a new 6-digit code. The old code stops working right away and any open session is signed out.`,
      confirmLabel: "Regenerate",
    });
    if (!ok) return;
    try {
      const r = await api<{ code: string }>(`/api/admin/staff/${row.id}/regenerate`, {});
      setReveal({ name: row.name ?? "Staff member", code: r.code });
    } catch (err) {
      toast.show({ type: "error", message: (err as ApiError).message });
    }
  }

  async function onToggleActive(row: StaffRow) {
    if (row.active) {
      const ok = await confirm({
        title: "Deactivate this staff member?",
        message: `${row.name ?? "This staff member"} can no longer sign in and any open session is signed out. You can reactivate later.`,
        confirmLabel: "Deactivate",
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await apiPatch(`/api/admin/staff/${row.id}`, { active: !row.active });
      toast.show({
        type: "success",
        message: row.active ? "Staff member deactivated." : "Staff member reactivated.",
      });
      await load();
    } catch (err) {
      toast.show({ type: "error", message: (err as ApiError).message });
    }
  }

  if (forbidden) {
    return (
      <EmptyState
        title="Owner access only"
        hint="Staff management is available to the owner account. Sign in as the owner to manage staff logins."
      />
    );
  }

  return (
    <>
      <header className="staff-head">
        <div>
          <h1>Staff logins</h1>
          <p className="sub">Give each person their own 6-digit code, so every action shows who did it.</p>
        </div>
      </header>

      <div className="staff-stack">
        <div className="panel">
          <div className="staff-panel-head"><h2>Add a staff member</h2></div>
          <form onSubmit={onCreate} className="staff-create">
            <div className="field">
              <label htmlFor="staff-name">Name</label>
              <input id="staff-name" value={name} maxLength={80} required
                placeholder="For example: Maya"
                onChange={(e) => setName(e.target.value)} />
            </div>
            <button className="btn" disabled={busy || name.trim() === ""}>
              {busy ? "Creating…" : "Create staff login"}
            </button>
          </form>
        </div>

        <div className="panel">
          <div className="staff-panel-head"><h2>Team</h2></div>
          {loading ? (
            <table className="grid" aria-busy="true">
              <thead><tr><th>Name</th><th>Status</th><th>Since</th><th /></tr></thead>
              <tbody>
                {Array.from({ length: 3 }).map((_, r) => (
                  <tr key={r}>
                    <td><Skeleton width="55%" /></td>
                    <td><Skeleton width={70} radius={6} /></td>
                    <td><Skeleton width="45%" /></td>
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
          ) : staff.length === 0 ? (
            <EmptyState
              title="No staff yet"
              hint="Create the first staff login above. Each person gets a personal code shown exactly once."
            />
          ) : (
            <table className="grid">
              <thead><tr><th>Name</th><th>Status</th><th>Since</th><th /></tr></thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name ?? "Unnamed"}</td>
                    <td><span className="tag">{s.active ? "Active" : "Deactivated"}</span></td>
                    <td>{new Date(s.createdAt).toLocaleDateString()}</td>
                    <td className="staff-actions">
                      <button type="button" className="btn btn--quiet" onClick={() => onRegenerate(s)} disabled={!s.active}>
                        Regenerate code
                      </button>
                      <button type="button" className="btn btn--quiet" onClick={() => onToggleActive(s)}>
                        {s.active ? "Deactivate" : "Reactivate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel">
          <div className="staff-panel-head"><h2>Recent logins</h2></div>
          {loading ? (
            <Skeleton width="60%" />
          ) : logins.length === 0 ? (
            <EmptyState
              title="No logins recorded yet"
              hint="Every owner and staff sign-in shows up here."
            />
          ) : (
            <table className="grid">
              <thead><tr><th>Who</th><th>When</th></tr></thead>
              <tbody>
                {logins.map((l) => (
                  <tr key={l.id}>
                    <td>{l.actorLabel}</td>
                    <td>{new Date(l.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Modal
        open={reveal !== null}
        onClose={() => setReveal(null)}
        title={reveal ? `Login code for ${reveal.name}` : "Login code"}
        description="Write it down or hand it over now. For safety it is not shown again."
        footer={
          <button type="button" className="btn" onClick={() => setReveal(null)}>
            Done, I saved it
          </button>
        }
      >
        <p className="staff-code" aria-live="polite">{reveal?.code}</p>
        <p className="sub">If the code is lost, use Regenerate code to issue a new one.</p>
      </Modal>
    </>
  );
}
