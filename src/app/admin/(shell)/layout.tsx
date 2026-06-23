import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { resolveSession } from "@/lib/auth/sessions";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { getDb } from "@/lib/db/client";
import { adminUsers } from "@/lib/db/schema";
import { LogoutButton } from "./logout-button";
import { NotificationBell } from "./notification-bell";
import { SideNav } from "./side-nav";
import "../admin.css";

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
    <div className="shell">
      <aside className="side">
        <div className="logo">FLEET<b>DESK</b> Admin</div>
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
  );
}
