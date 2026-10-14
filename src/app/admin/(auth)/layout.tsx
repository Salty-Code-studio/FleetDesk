import type { ReactNode } from "react";
import { fontVars } from "@/app/fonts";
import "../admin.css";

export const metadata = { title: "Yabi Desk", robots: { index: false, follow: false } };

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <div className={`auth-wrap ${fontVars}`}>{children}</div>;
}
