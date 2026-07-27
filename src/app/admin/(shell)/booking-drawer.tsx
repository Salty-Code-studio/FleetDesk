"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { apiGet, api, apiPatch, type ApiError } from "../client";
import { Drawer, Modal, useToast, SkeletonRows } from "@/app/admin/_ui";
import { DatePicker, Select, TimeSelect } from "@/components/ui";
import { formatDateTime, atAruba, arubaDateOf, arubaTimeOf } from "@/lib/time/format";
import "./booking-drawer.css";

interface BookingDetailPayment {
  id: string;
  type: string;
  method: string;
  amountCents: number;
  refundedCents: number;
  status: string;
  createdAt: string;
  stripePaymentIntentId: string | null;
}
interface BookingDetail {
  booking: {
    id: string;
    status: string;
    source: string;
    startAt: string;
    endAt: string;
    paymentOption: string;
    notes: string | null;
    priceBreakdown: { subtotalCents: number; depositCents: number | null; currency: string };
    amountPaidCents: number;
  };
  customer: { name: string; email: string; phone: string };
  vehicle: { id: string; name: string; plate: string };
  payments: BookingDetailPayment[];
  balanceDueCents: number;
  policySaysFree: boolean;
}
interface VehicleOption { id: string; plate: string; name: string }

export interface BookingDrawerProps {
  bookingId: string | null;
  onClose: () => void;
  /** Re-fetch planning data after any mutation (move, cancel, refund). */
  onChanged: () => void;
  /** Extension point: renders after Payments, before Actions. Wave 06 injects
   *  Checklist + Inspections here. Defaults to nothing. */
  extraSections?: ReactNode;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  picked_up: "With customer",
  cancelled: "Cancelled",
  completed: "Completed",
};
const TYPE_LABEL: Record<string, string> = {
  reservation_fee: "Reservation fee",
  deposit: "Deposit",
  rental_deposit: "Deposit",
  rental_full: "Full rental",
  extension: "Extension",
};
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

/**
 * The one-click booking surface: click a bar on the planning board, get
 * everything about that rental in one panel — who, what, when, what's been
 * paid, what's still owed, and the actions the desk needs (move, extend,
 * cancel). Fetches its own detail from GET /api/admin/bookings/:id and its
 * own vehicle list (for Move) so the parent board only has to pass an id.
 */
export function BookingDrawer({ bookingId, onClose, onChanged, extraSections = null }: BookingDrawerProps) {
  const [detail, setDetail] = useState<BookingDetail | null>(null);
  const [loading, setLoading] = useState(false);

  const [showMove, setShowMove] = useState(false);
  const [moveBusy, setMoveBusy] = useState(false);
  const [vehicles, setVehicles] = useState<VehicleOption[]>([]);
  const [mv, setMv] = useState({ vehicleId: "", startDate: "", startTime: "09:00", endDate: "", endTime: "09:00" });

  const [refundFor, setRefundFor] = useState<BookingDetailPayment | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundBusy, setRefundBusy] = useState(false);

  const [showCancel, setShowCancel] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);

  const toast = useToast();

  const load = useCallback(async () => {
    if (!bookingId) { setDetail(null); return; }
    setLoading(true);
    try {
      setDetail(await apiGet<BookingDetail>(`/api/admin/bookings/${bookingId}`));
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError).message });
    }
    setLoading(false);
  }, [bookingId, toast]);

  useEffect(() => { void load(); }, [load]);

  // Switching to a different booking (or closing) drops any in-progress
  // sub-panel from the previous one — never carry a stale Move/Refund/Cancel
  // form over to a booking it does not belong to.
  useEffect(() => {
    setShowMove(false);
    setRefundFor(null);
    setShowCancel(false);
  }, [bookingId]);

  async function openMove() {
    if (!detail) return;
    setMv({
      vehicleId: detail.vehicle.id,
      startDate: arubaDateOf(detail.booking.startAt), startTime: arubaTimeOf(detail.booking.startAt),
      endDate: arubaDateOf(detail.booking.endAt), endTime: arubaTimeOf(detail.booking.endAt),
    });
    setShowMove(true);
    if (vehicles.length === 0) {
      try { setVehicles(await apiGet<VehicleOption[]>("/api/admin/vehicles")); }
      catch (e) { toast.show({ type: "error", message: (e as ApiError).message }); }
    }
  }

  async function submitMove(e: FormEvent) {
    e.preventDefault();
    if (!bookingId) return;
    setMoveBusy(true);
    try {
      await apiPatch(`/api/admin/bookings/${bookingId}/move`, {
        vehicleId: mv.vehicleId,
        startAt: atAruba(mv.startDate, mv.startTime), endAt: atAruba(mv.endDate, mv.endTime),
      });
      toast.show({ type: "success", message: "Moved." });
      setShowMove(false);
      onChanged();
      await load();
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError).message });
    }
    setMoveBusy(false);
  }

  function openRefund(p: BookingDetailPayment) {
    const remaining = p.amountCents - p.refundedCents;
    setRefundAmount((remaining / 100).toFixed(2));
    setRefundFor(p);
  }

  async function submitRefund(e: FormEvent) {
    e.preventDefault();
    if (!refundFor) return;
    setRefundBusy(true);
    try {
      const amountCents = Math.round(Number(refundAmount) * 100);
      await api(`/api/admin/payments/${refundFor.id}/refund`, { amountCents });
      toast.show({ type: "success", message: `Refunded ${money(amountCents)}.` });
      setRefundFor(null);
      onChanged();
      await load();
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError).message });
    }
    setRefundBusy(false);
  }

  async function doCancel(refund: boolean) {
    if (!bookingId) return;
    setCancelBusy(true);
    try {
      await api(`/api/admin/bookings/${bookingId}/cancel`, { refund });
      toast.show({ type: "success", message: "Booking cancelled." });
      setShowCancel(false);
      onChanged();
      onClose();
    } catch (e) {
      toast.show({ type: "error", message: (e as ApiError).message });
    }
    setCancelBusy(false);
  }

  const b = detail?.booking;
  const canCancel = b?.status === "pending" || b?.status === "confirmed";

  return (
    <>
      <Drawer
        open={bookingId !== null}
        onClose={onClose}
        title={detail?.customer.name || "Booking"}
        description={detail ? `${detail.vehicle.plate} · ${detail.vehicle.name}` : undefined}
        size="lg"
      >
        {loading && !detail && <SkeletonRows rows={4} cols={2} />}
        {!loading && !detail && <p className="muted">Couldn&apos;t load this booking.</p>}
        {detail && b && (
          <div className="bd">
            <section className="bd-section">
              <h3>Summary</h3>
              <dl className="bd-summary">
                <div>
                  <dt>Customer</dt>
                  <dd>{detail.customer.name || detail.customer.email}<small>{detail.customer.email} · {detail.customer.phone || "no phone on file"}</small></dd>
                </div>
                <div>
                  <dt>Vehicle</dt>
                  <dd>{detail.vehicle.plate} · {detail.vehicle.name}</dd>
                </div>
                <div className="bd-period">
                  <dt>Period</dt>
                  <dd>{formatDateTime(b.startAt)} to {formatDateTime(b.endAt)}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd><span className={`bd-status bd-status--${b.status}`}>{STATUS_LABEL[b.status] ?? b.status}</span></dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd><span className="tag">{b.source === "manual" ? "Manual" : "Online"}</span></dd>
                </div>
              </dl>
              {b.notes && <p className="pl-pop-note">{b.notes}</p>}
            </section>

            <section className="bd-section">
              <h3>Payments</h3>
              {detail.payments.length === 0 ? (
                <p className="muted">No payments yet.</p>
              ) : (
                <div className="bd-payments">
                  {detail.payments.map((p) => {
                    const remaining = p.amountCents - p.refundedCents;
                    return (
                      <div className="bd-payment-row" key={p.id}>
                        <span className="bd-payment-type">{TYPE_LABEL[p.type] ?? p.type}</span>
                        <span className="tag">{p.method}</span>
                        <span className={`tag ${p.status === "succeeded" ? "on" : p.status === "failed" ? "off" : ""}`}>{p.status}</span>
                        {p.refundedCents > 0 && <span className="tag off">Refunded {money(p.refundedCents)}</span>}
                        <span className="bd-payment-amt">{money(p.amountCents)}</span>
                        {p.status === "succeeded" && remaining > 0 && (
                          <button type="button" className="btn btn--quiet" onClick={() => openRefund(p)}>Refund</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="bd-balance">Paid {money(b.amountPaidCents)} · Balance due at pickup {money(detail.balanceDueCents)}</p>
            </section>

            {extraSections}

            <section className="bd-section">
              <h3>Actions</h3>
              {!showMove ? (
                <div className="pl-pop-actions">
                  <button type="button" className="btn btn--quiet" onClick={openMove}>Move…</button>
                  <button type="button" className="btn btn--quiet" disabled title="Extension arrives in the next task">Extend</button>
                  {canCancel && (
                    <button type="button" className="btn danger" onClick={() => setShowCancel(true)}>Cancel rental</button>
                  )}
                </div>
              ) : (
                <form className="pl-form" onSubmit={submitMove}>
                  <label>Car
                    <Select
                      value={mv.vehicleId}
                      onChange={(v) => setMv({ ...mv, vehicleId: v })}
                      options={vehicles.map((v) => ({ value: v.id, label: `${v.plate} · ${v.name}` }))}
                      placeholder="Loading cars…"
                    />
                  </label>
                  <div className="bd-dates">
                    <label>Pick-up<DatePicker required value={mv.startDate} onChange={(iso) => setMv({ ...mv, startDate: iso })} /></label>
                    <label>Pick-up time<TimeSelect value={mv.startTime} onChange={(t) => setMv({ ...mv, startTime: t })} /></label>
                    <label>Return<DatePicker required value={mv.endDate} onChange={(iso) => setMv({ ...mv, endDate: iso })} /></label>
                    <label>Return time<TimeSelect value={mv.endTime} onChange={(t) => setMv({ ...mv, endTime: t })} /></label>
                  </div>
                  <div className="pl-pop-actions">
                    <button className="btn btn--accent" disabled={moveBusy}>{moveBusy ? "Saving…" : "Save move"}</button>
                    <button type="button" className="btn btn--quiet" onClick={() => setShowMove(false)}>Back</button>
                  </div>
                </form>
              )}
            </section>
          </div>
        )}
      </Drawer>

      <Modal
        open={refundFor !== null}
        onClose={() => setRefundFor(null)}
        title="Refund payment"
        description={refundFor ? `${TYPE_LABEL[refundFor.type] ?? refundFor.type} · ${money(refundFor.amountCents)} paid` : undefined}
        size="sm"
        footer={
          <>
            <button type="button" className="btn btn--quiet" onClick={() => setRefundFor(null)}>Cancel</button>
            <button type="submit" form="bd-refund-form" className="btn btn--accent" disabled={refundBusy}>{refundBusy ? "Refunding…" : "Refund"}</button>
          </>
        }
      >
        <form id="bd-refund-form" className="pl-form" onSubmit={submitRefund}>
          <label>Amount (USD)
            <input
              data-autofocus
              type="number"
              step="0.01"
              min="0.01"
              max={refundFor ? (refundFor.amountCents - refundFor.refundedCents) / 100 : undefined}
              required
              value={refundAmount}
              onChange={(e) => setRefundAmount(e.target.value)}
            />
          </label>
        </form>
      </Modal>

      <Modal
        open={showCancel}
        onClose={() => setShowCancel(false)}
        title="Cancel this rental?"
        description={b ? `${detail?.vehicle.plate} · ${formatDateTime(b.startAt)} to ${formatDateTime(b.endAt)}` : undefined}
        size="sm"
        footer={
          <>
            <button type="button" className="btn btn--quiet" onClick={() => setShowCancel(false)} disabled={cancelBusy}>Keep rental</button>
            <button
              type="button"
              className="btn"
              data-autofocus={detail && !detail.policySaysFree ? true : undefined}
              disabled={cancelBusy}
              onClick={() => doCancel(false)}
            >
              Cancel without refund
            </button>
            <button
              type="button"
              className="btn btn--accent"
              data-autofocus={detail && detail.policySaysFree ? true : undefined}
              disabled={cancelBusy}
              onClick={() => doCancel(true)}
            >
              Cancel and refund
            </button>
          </>
        }
      >
        <p className="muted">
          {detail?.policySaysFree
            ? "This is outside the cancellation window, so a refund is expected."
            : "This is inside the cancellation window, so policy alone would not refund it. The desk can still choose to."}
        </p>
      </Modal>
    </>
  );
}
