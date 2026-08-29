/**
 * Public brand configuration. Values come from NEXT_PUBLIC_* env vars, which
 * Next.js inlines at build time, so this module is safe in client AND server
 * code. A white-label deploy (the Tex Cars port) becomes an env change instead
 * of string surgery.
 */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://fleetdesk.app";
const whatsappDigits = (process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? "").replace(/[^0-9]/g, "");

/** Human-readable phone from the wa.me digits. Aruba numbers (297 + 7 local
 *  digits) get the local 3+4 grouping ("+297 594 5454"); any other country
 *  renders as plain +digits, since per-country grouping rules are not worth
 *  carrying here. Null when no number is configured, so surfaces can drop
 *  their phone line entirely (same contract as whatsappHref). */
function formatPhoneDisplay(digits: string): string | null {
  if (!digits) return null;
  const aruba = /^297(\d{3})(\d{4})$/.exec(digits);
  return aruba ? `+297 ${aruba[1]} ${aruba[2]}` : `+${digits}`;
}

export interface SiteConfig {
  siteName: string;
  siteUrl: string;
  backLinkLabel: string;
  whatsappHref: string | null;
  /** Written-out contact number for email/print surfaces ("+297 594 5454").
   *  Derived from NEXT_PUBLIC_WHATSAPP_NUMBER; null when unset. */
  whatsappDisplay: string | null;
}

export const siteConfig: SiteConfig = {
  siteName: process.env.NEXT_PUBLIC_SITE_NAME ?? "FleetDesk",
  siteUrl,
  backLinkLabel: `Back to ${hostOf(siteUrl)}`,
  whatsappHref: whatsappDigits ? `https://wa.me/${whatsappDigits}` : null,
  whatsappDisplay: formatPhoneDisplay(whatsappDigits),
};
