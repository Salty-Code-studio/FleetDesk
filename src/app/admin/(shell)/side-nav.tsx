"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/reports", label: "Reports" },
  { href: "/admin/fleet", label: "Fleet & pricing" },
  { href: "/admin/catalog", label: "Add-ons & insurance" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/policies", label: "Policies" },
  { href: "/admin/audit", label: "Audit log" },
];

export function SideNav() {
  const pathname = usePathname();
  return (
    <nav className="side-nav">
      {LINKS.map((l) => {
        const active = l.href === "/admin" ? pathname === "/admin" : pathname.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
            {l.label}
          </Link>
        );
      })}
      <a href="#" className="soon" aria-disabled="true">Bookings (Plan 04)</a>
    </nav>
  );
}
