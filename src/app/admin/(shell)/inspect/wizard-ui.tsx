"use client";

/**
 * Shared building blocks for the check-in / check-out wizards (spec W4).
 * Mobile-first: big tap targets, camera capture, and a HAND-ROLLED signature
 * canvas (pointer events -> PNG, CSP-safe, zero dependencies). All media
 * renders through the same-origin /api/admin/files route because the strict
 * admin CSP (img-src 'self') forbids cross-origin storage URLs.
 */
import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { getCsrfToken } from "@/app/admin/client";
import { ringFraction, type FinishLine } from "@/lib/admin/wizard-progress";
import "./inspect.css";

export const ANGLES = [
  { id: "front", label: "Front" },
  { id: "back", label: "Back" },
  { id: "left", label: "Left side" },
  { id: "right", label: "Right side" },
  { id: "interior", label: "Interior" },
  { id: "dash", label: "Dash and odometer" },
] as const;

export type AngleId = (typeof ANGLES)[number]["id"];

export const fileUrl = (key: string) => `/api/admin/files/${key}`;

/* ---------- client mirrors of the server payloads (Task 5 shapes) ---------- */

export interface InspectionDto {
  id: string;
  kind: "pickup" | "return";
  odometer: number | null;
  fuelLevel: number | null;
  notes: string;
  photos: { key: string; label: string }[];
  damageCheck: "none" | "found" | null;
  licensePhotoKey: string | null;
  signatureKey: string | null;
  contractPdfKey: string | null;
  damageFlags: { photoKey: string; note: string }[];
  acceptedPolicyVersion: number | null;
  agreementSigned: boolean;
  rulesSigned: boolean;
  licenseCopyReceived: boolean;
  borgReceivedCents: number | null;
  borgMethod: string | null;
  borgReturnedCents: number | null;
  borgWithheldCents: number | null;
  borgWithheldReason: string | null;
  keysReturned: boolean;
}

export interface Handover {
  booking: {
    id: string; status: string; source: string; notes: string | null;
    startAt: string; endAt: string; currency: string;
    subtotalCents: number; amountPaidCents: number; balanceDueCents: number;
    priceLines: { label: string; cents: number }[];
    youngDriver: boolean;
    youngDriverFeeCents: number;
  };
  vehicle: { id: string; name: string; plate: string; class: string; depositCents: number | null };
  customer: { name: string | null; email: string; phone: string | null };
  license: { nameOnLicense: string; issuingCountry: string; expiryDate: string } | null;
  licenceCheck: { band: "young" | "standard"; bookedYoung: boolean; mismatch: boolean } | null;
  policy: { version: number; body: string } | null;
  inspections: { pickup: InspectionDto | null; return: InspectionDto | null };
}

export const money = (cents: number, currency: string) => `${currency} ${(cents / 100).toFixed(2)}`;

/* ------------------------------- uploading -------------------------------- */

/** Canvas downscale: longest edge maxEdge px, JPEG q0.85 (spec W4 storage layer). */
export async function downscaleImage(file: File, maxEdge = 1600): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d");
    if (!g) return file;
    g.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    return file; // un-decodable input: let the server-side type/size caps decide
  }
}

export interface UploadOpts {
  category: "inspection" | "license" | "signature";
  bookingId: string;
  kind?: "pickup" | "return";
  label?: string;
}

/** Multipart POST to /api/admin/uploads. Returns the storage key. */
export async function uploadBlob(blob: Blob, opts: UploadOpts): Promise<string> {
  const form = new FormData();
  form.append("file", blob, opts.category === "signature" ? "signature.png" : "photo.jpg");
  form.append("category", opts.category);
  form.append("bookingId", opts.bookingId);
  if (opts.kind) form.append("kind", opts.kind);
  if (opts.label) form.append("label", opts.label);
  const res = await fetch("/api/admin/uploads", {
    method: "POST",
    headers: { "X-CSRF-Token": getCsrfToken() }, // no Content-Type: the browser sets the multipart boundary
    body: form,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(data?.error?.message ?? "Upload failed. Please try again.");
  }
  return ((await res.json()) as { key: string }).key;
}

export async function capturePhoto(file: File, opts: UploadOpts): Promise<string> {
  return uploadBlob(await downscaleImage(file), opts);
}

/* ------------------------------- components ------------------------------- */

/** True when this browser can show a live camera inside the page. */
const canStream = () =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;

/**
 * Full-screen live camera: the back camera on a phone, the webcam on a laptop.
 * One shutter button; the frame comes back as a JPEG File, so it goes through
 * the same downscale + upload path as a picked file.
 */
export function CameraSheet({ label, onShot, onClose, onFallback }: {
  label: string;
  onShot: (file: File) => void;
  onClose: () => void;
  /** No camera or permission refused: hand over to the file picker instead. */
  onFallback: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) { v.srcObject = stream; void v.play().catch(() => undefined); }
      })
      .catch((e: Error) => {
        setError(e.name === "NotAllowedError"
          ? "Camera access was refused. Allow the camera in the browser, or upload a photo instead."
          : "No camera found on this device. Upload a photo instead.");
      });
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  const shoot = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((blob) => {
      if (blob) onShot(new File([blob], "camera.jpg", { type: "image/jpeg" }));
    }, "image/jpeg", 0.9);
  };

  return (
    <div className="wiz-cam" role="dialog" aria-modal="true" aria-label={`Camera: ${label}`}>
      <p className="wiz-cam__label">{label}</p>
      {error ? (
        <div className="wiz-cam__error">
          <p>{error}</p>
          <button type="button" className="wiz-btn" onClick={onFallback}>Upload a photo</button>
        </div>
      ) : (
        <video ref={videoRef} className="wiz-cam__video" playsInline muted autoPlay onLoadedData={() => setReady(true)} />
      )}
      <div className="wiz-cam__bar">
        <button type="button" className="wiz-btn ghost wiz-cam__cancel" onClick={onClose}>Cancel</button>
        {error ? null : (
          <button type="button" className="wiz-btn primary wiz-cam__shutter" onClick={shoot} disabled={!ready} aria-label="Take photo">
            Take photo
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One photo slot: "Take photo" opens the live camera (falls back to the
 * phone's camera app where streaming is not available), "Upload" picks a file
 * from the device. Both end in the same onFile.
 */
export function PhotoCapture({ label, photoKey, onFile, emptyText }: {
  label: string;
  photoKey: string | null;
  onFile: (file: File) => Promise<void>;
  /** Text in the empty frame; defaults to "No <label> photo yet". */
  emptyText?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [camOpen, setCamOpen] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const cameraAppRef = useRef<HTMLInputElement>(null);

  const handle = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      await onFile(file);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    void handle(file);
  };

  const lower = label.toLowerCase();
  return (
    <div className="wiz-photo">
      {photoKey
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={fileUrl(photoKey)} alt={label} />
        : <div className="wiz-photo-empty">{emptyText ?? `No ${lower} photo yet`}</div>}
      <div className="wiz-photo__actions">
        <button type="button" className="wiz-btn" disabled={busy} onClick={() => (canStream() ? setCamOpen(true) : cameraAppRef.current?.click())}>
          {busy ? "Uploading..." : photoKey ? "Retake" : "Take photo"}
        </button>
        <button type="button" className="wiz-btn ghost" disabled={busy} onClick={() => uploadRef.current?.click()}>
          Upload
        </button>
      </div>
      {/* Phone camera app, used only where the page cannot stream the camera. */}
      <input ref={cameraAppRef} type="file" accept="image/*" capture="environment" hidden onChange={pick} />
      {/* Plain picker: gallery, files, or a photo taken earlier. */}
      <input ref={uploadRef} type="file" accept="image/*" hidden onChange={pick} />
      {camOpen ? (
        <CameraSheet
          label={label}
          onClose={() => setCamOpen(false)}
          onFallback={() => { setCamOpen(false); uploadRef.current?.click(); }}
          onShot={(file) => { setCamOpen(false); void handle(file); }}
        />
      ) : null}
      {error ? <p className="wiz-error">{error}</p> : null}
    </div>
  );
}

export const FUEL_LABELS = ["E", "1/8", "1/4", "3/8", "1/2", "5/8", "3/4", "7/8", "F"] as const;

export function FuelSelector({ value, onChange }: { value: number | null; onChange: (v: number) => void }) {
  return (
    <div className="wiz-fuel" role="radiogroup" aria-label="Fuel level in eighths">
      {FUEL_LABELS.map((l, i) => (
        <button key={l} type="button" className={value === i ? "on" : ""} aria-pressed={value === i} onClick={() => onChange(i)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** Hand-rolled signature pad: pointer events on a canvas, exported as PNG. */
export function SignatureCanvas({ onBlob }: { onBlob: (blob: Blob | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = Math.round(rect.width * dpr);
    c.height = Math.round(180 * dpr);
    const g = c.getContext("2d");
    if (g) {
      g.scale(dpr, dpr);
      g.lineWidth = 2.5;
      g.lineCap = "round";
      g.lineJoin = "round";
      g.strokeStyle = "#1C2B2E"; // --ink: canvas strokes cannot read CSS vars
    }
  }, []);

  const pos = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const emit = () => canvasRef.current?.toBlob((b) => onBlob(b), "image/png");

  return (
    <div>
      <canvas
        ref={canvasRef}
        className="wiz-sig"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const g = e.currentTarget.getContext("2d");
          if (!g) return;
          drawing.current = true;
          const { x, y } = pos(e);
          g.beginPath();
          g.moveTo(x, y);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const g = e.currentTarget.getContext("2d");
          if (!g) return;
          const { x, y } = pos(e);
          g.lineTo(x, y);
          g.stroke();
          if (!hasInk) setHasInk(true);
        }}
        onPointerUp={() => {
          drawing.current = false;
          emit();
        }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
        <span className="wiz-sub">{hasInk ? "Signature captured" : "Sign above with a finger"}</span>
        <button
          type="button"
          className="wiz-btn ghost"
          onClick={() => {
            const c = canvasRef.current;
            const g = c?.getContext("2d");
            if (c && g) g.clearRect(0, 0, c.width, c.height);
            setHasInk(false);
            onBlob(null);
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

/** Progress ring: fills with the share of the checklist that is done. Teal,
 *  not coral, because progress is a status and coral only means "tap this". */
export function ProgressRing({ done, total, label }: { done: number; total: number; label: string }) {
  const f = ringFraction(done, total);
  const r = 15.5;
  const c = 2 * Math.PI * r;
  return (
    <span className={`wiz-ring${f === 1 ? " is-full" : ""}`} role="img" aria-label={`${label} ${Math.round(f * 100)}% done`}>
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle className="wiz-ring__track" cx="18" cy="18" r={r} />
        <circle className="wiz-ring__fill" cx="18" cy="18" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - f)} />
        {f === 1 ? <path className="wiz-ring__tick" d="M12 18.5l4 4 8-9" /> : null}
      </svg>
    </span>
  );
}

export function StepShell({ kicker, ring, title, children, onBack, onNext, nextLabel, nextDisabled }: {
  /** "Check-in" or "Check-out": names the ring for screen readers too. */
  kicker: string;
  ring: { done: number; total: number };
  title: string;
  children: ReactNode;
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
}) {
  return (
    <section className="wiz-step">
      <header className="wiz-head">
        <ProgressRing done={ring.done} total={ring.total} label={kicker} />
        <div>
          <p className="wiz-count">{kicker}</p>
          <h2>{title}</h2>
        </div>
      </header>
      <div className="wiz-body">{children}</div>
      <footer className="wiz-footer">
        {onBack ? <button type="button" className="wiz-btn ghost" onClick={onBack}>Back</button> : <span />}
        {onNext
          ? <button type="button" className="wiz-btn primary" onClick={onNext} disabled={nextDisabled}>{nextLabel ?? "Next"}</button>
          : null}
      </footer>
    </section>
  );
}

/**
 * Full-screen handover moment (three planes): the operator's name huge and
 * faint at the back, one sentence in the middle, one coral button on top.
 * Used when the phone goes to the customer and when it comes back.
 */
export function HandScreen({ backWord, title, body, goLabel, onGo, onBack }: {
  backWord: string;
  title: string;
  body: string;
  goLabel: string;
  onGo: () => void;
  onBack?: () => void;
}) {
  return (
    <section className="wiz-hand" aria-labelledby="wiz-hand-title">
      <p className="wiz-hand__back" aria-hidden="true">{backWord}</p>
      <div className="wiz-hand__mid">
        <h2 id="wiz-hand-title">{title}</h2>
        <p>{body}</p>
      </div>
      <div className="wiz-hand__top">
        <button type="button" className="wiz-btn primary wiz-hand__go" onClick={onGo} autoFocus>{goLabel}</button>
        {onBack ? <button type="button" className="wiz-btn ghost" onClick={onBack}>Back</button> : null}
      </div>
    </section>
  );
}

/** The last screen: one huge word, what got done, one way out. */
export function FinishScreen({ word, title, lines, doneLabel, onDone }: {
  word: string;
  title: string;
  lines: FinishLine[];
  doneLabel: string;
  onDone: () => void;
}) {
  return (
    <section className="wiz-finish" aria-labelledby="wiz-finish-title">
      <p className="wiz-finish__word" aria-hidden="true">{word}</p>
      <h2 id="wiz-finish-title">{title}</h2>
      <ul className="wiz-finish__list">
        {lines.map((l) => <li key={l.text} className={l.open ? "is-open" : undefined}>{l.text}</li>)}
      </ul>
      <button type="button" className="wiz-btn primary" onClick={onDone} autoFocus>{doneLabel}</button>
    </section>
  );
}

/** Finish-screen checklist row, shared by both wizards' last step. */
export function CheckList({ items }: { items: { label: string; ok: boolean }[] }) {
  return (
    <div className="wiz-card">
      {items.map((c) => (
        <div className="wiz-check" key={c.label}>
          <span>{c.label}</span>
          <span className={`state ${c.ok ? "ok" : "todo"}`}>{c.ok ? "done" : "open"}</span>
        </div>
      ))}
    </div>
  );
}
