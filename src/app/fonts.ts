import { Space_Grotesk, JetBrains_Mono, Inter } from "next/font/google";

// Self-hosted at build time via next/font/google: served from 'self' with an
// inline @font-face, so they satisfy the strict CSP (font-src 'self'). This is
// the ONLY place next/font may be called (guarded by
// src/test/fonts-single-source.test.ts). Every layout applies `fontVars` to its
// root wrapper so the CSS variables resolve for that subtree.
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

export const fontVars = `${display.variable} ${mono.variable} ${body.variable}`;
