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

export interface SiteConfig {
  siteName: string;
  siteUrl: string;
  backLinkLabel: string;
  whatsappHref: string | null;
}

export const siteConfig: SiteConfig = {
  siteName: process.env.NEXT_PUBLIC_SITE_NAME ?? "FleetDesk",
  siteUrl,
  backLinkLabel: `Back to ${hostOf(siteUrl)}`,
  whatsappHref: whatsappDigits ? `https://wa.me/${whatsappDigits}` : null,
};
