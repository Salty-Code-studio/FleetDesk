import type { ReactNode } from "react";
import { Space_Grotesk, JetBrains_Mono, Inter } from "next/font/google";
import "../admin.css";

// Same self-hosted next/font set as the shell, so the login / MFA cards render
// in Space Grotesk + JetBrains Mono under the strict CSP (font-src 'self'). The
// old Google Fonts @import in admin.css was CSP-blocked and never applied.
const display = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  weight: ["400", "500", "600", "700"],
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
  weight: ["400", "500", "600"],
});

const body = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
  weight: ["400", "500", "600", "700"],
});

const fontVars = `${display.variable} ${mono.variable} ${body.variable}`;

export const metadata = { title: "FleetDesk Admin", robots: { index: false, follow: false } };

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <div className={`auth-wrap ${fontVars}`}>{children}</div>;
}
