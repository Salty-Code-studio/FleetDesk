import { parseTs } from "@/lib/time/format";

/** Free cancellation strictly BEFORE (startAt - cancellationWindowHours).
 *  At or inside the window (and no-shows): the deposit is not refunded. */
export function isFreeCancellation(
  booking: { startAt: string },
  settings: { cancellationWindowHours: number },
  nowIso: string,
): boolean {
  return parseTs(nowIso) < parseTs(booking.startAt) - settings.cancellationWindowHours * 3_600_000;
}
