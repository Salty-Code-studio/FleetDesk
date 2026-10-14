import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { resolveSession } from "@/lib/auth/sessions";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { getDb } from "@/lib/db/client";
import { adminUsers } from "@/lib/db/schema";
import { AdminChrome } from "../_ui";
import { LogoutButton } from "./logout-button";
import { NotificationBell } from "./notification-bell";
import { SideNav } from "./side-nav";
import { fontVars } from "@/app/fonts";
import "../admin.css";

export const metadata = { title: "Yabi Desk", robots: { index: false, follow: false } };
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
  if (!admin.active) redirect("/admin/login"); // deactivated staff: instant revocation
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
            <span className="logo-word">Yabi</span>
            <span className="logo-tag">Desk</span>
          </div>
          <SideNav role={admin.role} />
          <div className="foot">
            <span className="foot-acct">{admin.name ?? admin.email} · {admin.role}</span>
            <span className="foot-by">a saltycodestudio product</span>
          </div>
        </aside>
        <main className="main">
          <div className="topbar">
            {admin.role === "owner" && <NotificationBell />}
            <LogoutButton />
          </div>
          {children}
        </main>
      </div>
    </AdminChrome>
  );
}
