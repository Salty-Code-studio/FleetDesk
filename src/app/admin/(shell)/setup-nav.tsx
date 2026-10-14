"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/catalog", label: "Add-ons & insurance" },
  { href: "/admin/policies", label: "Policies" },
  { href: "/admin/staff", label: "Staff" },
  { href: "/admin/audit", label: "Audit log" },
];

/** Sub-navigation shared by every page that lives under the Setup verb. */
export function SetupNav() {
  const pathname = usePathname();
  return (
    <nav className="setup-nav" aria-label="Setup sections">
      {TABS.map((t) => {
        const active = pathname.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
