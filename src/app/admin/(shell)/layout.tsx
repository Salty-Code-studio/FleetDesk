import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Space_Grotesk, JetBrains_Mono, Inter } from "next/font/google";
import { eq } from "drizzle-orm";
import { resolveSession } from "@/lib/auth/sessions";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { getDb } from "@/lib/db/client";
import { adminUsers } from "@/lib/db/schema";
import { AdminChrome } from "../_ui";
import { LogoutButton } from "./logout-button";
import { NotificationBell } from "./notification-bell";
import { SideNav } from "./side-nav";
import "../admin.css";

// Self-hosted at build time via next/font/google: served from 'self' with an
// inline @font-face, so they satisfy the strict UI CSP (font-src 'self'). This
// replaces the CSP-blocked Google Fonts @import that admin.css used to carry,
// which is why Space Grotesk / JetBrains Mono never actually rendered in admin.
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
export const dynamic = "force-dynamic";

/**
 * The gate for everything inside the shell: a live, fully-authenticated admin
 * session with MFA enrolled. Anything less bounces to login/MFA server-side,
 * before any dashboard data is rendered.
 */
export default async function ShellLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const session = await resolveSession(cookieStore.get(SESSION_COOKIE)?.value);
  if (!session || session.subjectType !== "admin") redirect("/admin/login");
  if (session.mfaPending) redirect("/admin/mfa");

  const db = await getDb();
  const [admin] = await db.select().from(adminUsers).where(eq(adminUsers.id, session.subjectId));
  if (!admin) redirect("/admin/login");
  if (!admin.mfaEnabled) redirect("/admin/mfa"); // enrollment is mandatory

  return (
    // fontVars lives on the AdminChrome root wrapper (one level up), so it
    // scopes the self-hosted next/font variables over BOTH this .shell and the
    // overlay surfaces AdminChrome mounts (toaster, confirm Modal, command
    // palette). Keeping it here too would only re-declare the same variables.
    <AdminChrome fontVars={fontVars}>
      <div className="shell">
        <aside className="side">
          <div className="logo">
            <span className="logo-mark" aria-hidden="true">
              ~&lt;
            </span>
            <span className="logo-word">FleetDesk</span>
            <span className="logo-tag">Admin</span>
          </div>
          <SideNav />
          <div className="foot">
            <span className="foot-acct">{admin.email} · {admin.role}</span>
            <span className="foot-by">a saltycodestudio product</span>
          </div>
        </aside>
        <main className="main">
          <div className="topbar">
            <NotificationBell />
            <LogoutButton />
          </div>
          {children}
        </main>
      </div>
    </AdminChrome>
  );
}
