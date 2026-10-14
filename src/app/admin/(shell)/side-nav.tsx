"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavLink { href: string; label: string; staff?: boolean; also?: string[] }

// Five verbs. staff: true marks the pages a staff code login may use; hiding is
// presentation only, the API role guards enforce the same list server-side.
// `also` lists the routes that count as "inside" this verb for the active state.
export const LINKS: NavLink[] = [
  { href: "/admin", label: "Today", staff: true },
  { href: "/admin/board", label: "Board", staff: true },
  { href: "/admin/fleet", label: "Fleet", staff: true },
  { href: "/admin/reports", label: "Money" },
  { href: "/admin/settings", label: "Setup", also: ["/admin/catalog", "/admin/policies", "/admin/staff", "/admin/audit"] },
];

export function isActive(link: NavLink, pathname: string): boolean {
  if (link.href === "/admin") return pathname === "/admin";
  return [link.href, ...(link.also ?? [])].some((p) => pathname.startsWith(p));
}

export function SideNav({ role }: { role: "owner" | "staff" }) {
  const pathname = usePathname();
  const visible = role === "staff" ? LINKS.filter((l) => l.staff) : LINKS;
  return (
    <nav className="side-nav">
      {visible.map((l) => {
        const active = isActive(l, pathname);
        return (
          <Link key={l.href} href={l.href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
