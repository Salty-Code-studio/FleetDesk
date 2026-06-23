import type { ReactNode } from "react";
import "../admin.css";

export const metadata = { title: "FleetDesk Admin", robots: { index: false, follow: false } };

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <div className="auth-wrap">{children}</div>;
}
