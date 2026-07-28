"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavLink { href: string; label: string; staff?: boolean }

// staff: true marks the pages a staff code login may use (workstream 8).
// Everything else is owner-only and hidden from staff. Hiding is presentation
// only; the API role guards enforce the same list server-side.
const LINKS: NavLink[] = [
  { href: "/admin", label: "Dashboard", staff: true },
  { href: "/admin/reports", label: "Reports" },
  { href: "/admin/fleet", label: "Fleet & pricing", staff: true },
  { href: "/admin/catalog", label: "Add-ons & insurance" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/policies", label: "Policies" },
  { href: "/admin/staff", label: "Staff" },
  { href: "/admin/audit", label: "Audit log" },
];

export function SideNav({ role }: { role: "owner" | "staff" }) {
  const pathname = usePathname();
  const visible = role === "staff" ? LINKS.filter((l) => l.staff) : LINKS;
  return (
    <nav className="side-nav">
      {visible.map((l) => {
        const active = l.href === "/admin" ? pathname === "/admin" : pathname.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
