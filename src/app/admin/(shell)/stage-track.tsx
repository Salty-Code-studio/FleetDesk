import { STAGES, type StageView } from "@/lib/admin/booking-stage";

/** Five-step track for the booking sheet. Cancelled collapses to one line. */
export function StageTrack({ view }: { view: StageView }) {
  if (view.cancelled) {
    return <p className="bd-track bd-track--cancelled">Cancelled</p>;
  }
  const at = STAGES.findIndex((s) => s.key === view.current);
  return (
    <ol className="bd-track" aria-label="Booking stage">
      {STAGES.map((s, i) => {
        const cls = i < at ? "is-done" : i === at ? "is-current" : "";
        return (
          <li key={s.key} className={`bd-track__step ${cls}`.trim()} aria-current={i === at ? "step" : undefined}>
            {s.label}
          </li>
        );
      })}
    </ol>
  );
}
