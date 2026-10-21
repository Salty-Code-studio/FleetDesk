"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { apiGet, api, apiPatch, apiDelete, type ApiError } from "../../client";
import { Drawer, useToast, useConfirm, useUndo } from "@/app/admin/_ui";
import { DatePicker, Select, TimeSelect } from "@/components/ui";
import { atAruba } from "@/lib/time/format";
import type { CardVehicle } from "./car-card";

interface Block { id: string; startDate: string; endDate: string; type: string; reason: string }
interface Note { id: string; body: string; createdAt: string; resolvedAt: string | null }

const BLOCK_TYPES = ["maintenance", "carwash", "cleaning", "out_of_service", "other"];
const EMPTY_BLOCK = { startDate: "", startTime: "00:00", endDate: "", endTime: "00:00", type: "maintenance", reason: "" };

interface Props {
  vehicle: CardVehicle | null;
  /** Staff may add, resolve and reopen notes; blocks, escalation, edit and retire are owner only. */
  isOwner: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  onEditRates: (v: CardVehicle) => void;
}

/** One sheet per car: notes, availability blocks, and retire / reactivate. */
export function CarSheet({ vehicle, isOwner, onClose, onChanged, onEditRates }: Props) {
  const toast = useToast();
  const undo = useUndo();
  const confirm = useConfirm();
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteBody, setNoteBody] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [bo, setBo] = useState({ ...EMPTY_BLOCK });
  // Keep the last car so the drawer content survives its slide-out.
  const [shown, setShown] = useState<CardVehicle | null>(vehicle);
  useEffect(() => { if (vehicle) setShown(vehicle); }, [vehicle]);
  const v = vehicle ?? shown;
  const vid = vehicle?.id ?? null;

  const fail = useCallback(
    (err: unknown) => toast.show({ type: "error", message: (err as ApiError).message }),
    [toast],
  );

  // The car whose sheet is open right now. Notes and blocks responses for any
  // other car are dropped, so a slow reply for the previous car can never
  // paint into this sheet (and "Block car for this" never acts on its notes).
  const openId = useRef<string | null>(vid);
  openId.current = vid;

  const loadNotes = useCallback(async (id: string) => {
    const list = await apiGet<Note[]>(`/api/admin/vehicles/${id}/notes`);
    if (openId.current === id) setNotes(list);
  }, []);
  const loadBlocks = useCallback(async (id: string) => {
    const list = await apiGet<Block[]>(`/api/admin/vehicles/${id}/blocks`);
    if (openId.current === id) setBlocks(list);
  }, []);

  useEffect(() => {
    if (!vid) return;
    let live = true;
    const failIfLive = (err: unknown) => { if (live) fail(err); };
    setNotes([]); setBlocks([]); setNoteBody(""); setBo({ ...EMPTY_BLOCK });
    void loadNotes(vid).catch(failIfLive);
    if (isOwner) void loadBlocks(vid).catch(failIfLive);
    return () => { live = false; };
  }, [vid, isOwner, loadNotes, loadBlocks, fail]);

  async function refreshNotes(id: string) {
    await loadNotes(id);
    await onChanged(); // open-note counts on the cards come from the vehicles list
  }
  async function addNote(e: FormEvent) {
    e.preventDefault();
    if (!v) return;
    try {
      await api(`/api/admin/vehicles/${v.id}/notes`, { body: noteBody });
      setNoteBody("");
      await refreshNotes(v.id);
      toast.show({ type: "success", message: "Note added." });
    } catch (err) { fail(err); }
  }
  async function resolveNote(n: Note, resolved: boolean) {
    if (!v) return;
    try {
      await apiPatch(`/api/admin/notes/${n.id}`, { resolved });
      await refreshNotes(v.id);
      toast.show({ type: "success", message: resolved ? "Note resolved." : "Note reopened." });
    } catch (err) { fail(err); }
  }
  async function escalateNote(n: Note) {
    if (!v) return;
    const ok = await confirm({
      title: "Block this car?",
      message: `${v.plate} gets a 7 day maintenance block starting today for: "${n.body}". You can adjust or remove it under Blocks. The note stays open until you resolve it.`,
      confirmLabel: "Block car",
    });
    if (!ok) return;
    try {
      await api(`/api/admin/notes/${n.id}/escalate`, {});
      await refreshNotes(v.id);
      await loadBlocks(v.id);
      toast.show({ type: "success", message: "Car blocked for 7 days. Adjust it under Blocks if needed." });
    } catch (err) { fail(err); }
  }

  async function addBlock(e: FormEvent) {
    e.preventDefault();
    if (!v) return;
    try {
      await api(`/api/admin/vehicles/${v.id}/blocks`, {
        startAt: atAruba(bo.startDate, bo.startTime), endAt: atAruba(bo.endDate, bo.endTime),
        type: bo.type, reason: bo.reason,
      });
      setBo({ ...EMPTY_BLOCK });
      await loadBlocks(v.id);
      toast.show({ type: "success", message: "Block added." });
    } catch (err) { fail(err); }
  }
  async function removeBlock(id: string) {
    const ok = await confirm({
      title: "Delete this block?",
      message: "The dates open back up for booking.",
      confirmLabel: "Delete block",
      danger: true,
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/admin/blocks/${id}`);
      if (v) await loadBlocks(v.id);
      toast.show({ type: "success", message: "Block deleted." });
    } catch (err) { fail(err); }
  }

  async function retire() {
    if (!v) return;
    const previous = v.status;
    const { id, plate } = v;
    try {
      await apiDelete(`/api/admin/vehicles/${id}`);
      await onChanged();
      onClose();
      undo(`${plate} retired.`, async () => {
        await apiPatch(`/api/admin/vehicles/${id}`, { status: previous });
        await onChanged();
      });
    } catch (err) { fail(err); }
  }
  async function reactivate() {
    if (!v) return;
    try {
      await apiPatch(`/api/admin/vehicles/${v.id}`, { status: "active" });
      await onChanged();
      onClose();
      toast.show({ type: "success", message: `${v.plate} is active again.` });
    } catch (err) { fail(err); }
  }

  const retired = v?.status === "retired";
  return (
    <Drawer
      open={vehicle !== null}
      onClose={onClose}
      title={v ? v.plate : "Car"}
      description={v ? `${v.name} · ${v.class}` : undefined}
      size="md"
      footer={
        v ? (
          <>
            <button type="button" className="btn btn--quiet" onClick={onClose}>Close</button>
            {isOwner && (
              <>
                <button type="button" className="btn" onClick={() => { onClose(); onEditRates(v); }}>Edit car</button>
                {retired ? (
                  <button type="button" className="btn" onClick={reactivate}>Reactivate</button>
                ) : (
                  <button type="button" className="btn danger" onClick={retire}>Retire car</button>
                )}
              </>
            )}
          </>
        ) : undefined
      }
    >
      <section className="fc-sec" aria-labelledby="fc-notes-h">
        <h3 id="fc-notes-h" className="fc-sec__h">Notes</h3>
        <form className="inline-form fleet-note-form" onSubmit={addNote}>
          <label>New note<br />
            <input required maxLength={500} value={noteBody} onChange={(e) => setNoteBody(e.target.value)} placeholder="e.g. customer says brakes feel soft" />
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
                      {isOwner && <button onClick={() => escalateNote(n)}>Block car for this</button>}
                    </>
                  ) : (
                    <button onClick={() => resolveNote(n, false)}>Reopen</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isOwner && (
        <section className="fc-sec" aria-labelledby="fc-blocks-h">
          <h3 id="fc-blocks-h" className="fc-sec__h">Availability blocks</h3>
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
            <label>Type<br /><Select value={bo.type} onChange={(t) => setBo({ ...bo, type: t })} options={BLOCK_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, " ") }))} /></label>
            <label>Reason<br /><input value={bo.reason} onChange={(e) => setBo({ ...bo, reason: e.target.value })} /></label>
            <button className="btn" style={{ width: "auto" }}>Add block</button>
          </form>
          <p className="muted fleet-block-hint">Leave 00:00 for full days.</p>
        </section>
      )}
    </Drawer>
  );
}
