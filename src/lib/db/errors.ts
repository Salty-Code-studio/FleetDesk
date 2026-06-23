/**
 * Translate Postgres constraint violations into safe AppErrors so a race or a
 * bad reference becomes a clean 4xx instead of a generic 500. Drizzle wraps the
 * driver error, so the SQLSTATE code can sit on the error or its `cause`.
 */
import { Errors, AppError } from "@/lib/http/errors";

function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code ?? err?.cause?.code;
}

export function isUniqueViolation(e: unknown): boolean {
  return pgCode(e) === "23505";
}

/** Returns an AppError for a known constraint violation, else null (rethrow). */
export function translateDbError(e: unknown): AppError | null {
  switch (pgCode(e)) {
    case "23505": // unique_violation
      return Errors.conflict("That value is already in use");
    case "23P01": // exclusion_violation (the bookings overlap guard)
      return Errors.conflict("Those dates overlap an existing reservation");
    case "23503": // foreign_key_violation
      return Errors.badRequest("A referenced record does not exist");
    case "23514": // check_violation
      return Errors.badRequest("A value is out of its allowed range");
    case "22008": // datetime_field_overflow (e.g. an impossible calendar date)
    case "22007": // invalid_datetime_format
      return Errors.badRequest("That date is not valid");
    case "40001": // serialization_failure
    case "40P01": // deadlock_detected (concurrent locks acquired in opposite order)
      return Errors.conflict("That request collided with another, please try again");
    default:
      return null;
  }
}
