import type { ReactNode } from "react";
import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono, Inter } from "next/font/google";
import "./public.css";

// Fonts self-host at build time via next/font/google. They serve from 'self'
// with inline @font-face, so they pass the strict UI CSP. No external loads.
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
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = { title: "Book a car | FleetDesk" };

const fontVars = `${display.variable} ${mono.variable} ${body.variable}`;

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`pub ${fontVars}`}>
      <header className="pub-header">
        <div className="pub-header-inner">
          <a className="pub-brand" href="https://fleetdesk.app" aria-label="FleetDesk home">
            <span className="pub-brand-mark" aria-hidden="true">
              ~&lt;
            </span>
            <span className="pub-brand-word">FleetDesk</span>
          </a>
          <span className="pub-tag">We bring the car to you</span>
        </div>
      </header>
      {children}
    </div>
  );
}
