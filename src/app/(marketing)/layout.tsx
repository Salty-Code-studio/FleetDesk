import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { fontVars } from "@/app/fonts";
import "./marketing.css";

export const metadata: Metadata = {
  title: "Yabi · Booking and ops for car rental fleets",
  description:
    "Yabi is booking plus operations software for small car rental operators. Online booking, a never double-books guarantee, and one ops desk to run it all.",
  openGraph: {
    title: "Yabi · Run your fleet from one desk",
    description:
      "Online booking, a never double-books guarantee, and one ops desk for small car rental operators.",
    type: "website",
  },
};

// Show the "Live demo" entry only when the public demo is enabled. The server
// door (POST /api/admin/auth/demo) is separately gated by DEMO_MODE.
const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the inline script below intentionally adds the
    // mkt-js class before React hydrates, so the wrapper's className differs
    // between server and client by design (the next-themes pattern).
    <div className={`mkt ${fontVars}`} suppressHydrationWarning>
      {/* Set the JS flag synchronously so scroll-reveal is a flash-free
          enhancement: without it every section stays visible (no-JS, crawlers,
          pre-hydration). CSP allows inline scripts ('unsafe-inline'); no eval. */}
      <script
        dangerouslySetInnerHTML={{
          __html:
            "try{document.currentScript.parentElement.classList.add('mkt-js')}catch(e){}",
        }}
      />
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="site-header">
        <div className="shell site-header-inner">
          <Link className="brand" href="/" aria-label="Yabi home">
            <span className="brand-mark" aria-hidden="true">
              ~&lt;
            </span>
            <span className="brand-word">Yabi</span>
          </Link>

          <nav className="site-nav" aria-label="Primary">
            <Link className="nav-link nav-features" href="/#features">
              Features
            </Link>
            <Link className="nav-link" href="/pricing">
              Pricing
            </Link>
            <a className="nav-link nav-login" href="/admin">
              Log in
            </a>
            {DEMO_MODE ? (
              <Link className="btn btn-primary btn-sm" href="/admin/login">
                Live demo
              </Link>
            ) : (
              <Link className="btn btn-primary btn-sm" href="/early-access">
                Request access
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main id="main">{children}</main>

      <footer className="site-footer">
        <div className="shell site-footer-inner">
          <div className="footer-lead">
            <Link
              className="brand brand-on-teal"
              href="/"
              aria-label="Yabi home"
            >
              <span className="brand-mark" aria-hidden="true">
                ~&lt;
              </span>
              <span className="brand-word">Yabi</span>
            </Link>
            <p className="footer-pitch">
              Booking and ops for small car rental fleets. Run it all from one
              desk.
            </p>
          </div>

          <nav className="footer-nav" aria-label="Footer">
            <Link href="/#features">Features</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/early-access">Request access</Link>
            <a href="/admin">Log in</a>
          </nav>

          <div className="footer-fine">
            <span>Made by saltycodestudio</span>
            <span>&copy; {new Date().getFullYear()} Yabi</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
