/**
 * Resend SDK isolation. Returns null when email is unconfigured (no key), so
 * the rest of the app can treat email as best-effort and never depend on it.
 */
import { Resend } from "resend";
import { env } from "@/env";

let client: Resend | null | undefined;

export function getResend(): Resend | null {
  if (client !== undefined) return client;
  client = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
  return client;
}
