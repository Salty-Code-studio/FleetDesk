"use client";

import { useRouter } from "next/navigation";
import { api } from "../client";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      className="btn btn--quiet"
      onClick={async () => {
        try { await api("/api/admin/auth/logout"); } catch { /* cookie may already be gone */ }
        router.replace("/admin/login");
      }}
    >
      Sign out
    </button>
  );
}
