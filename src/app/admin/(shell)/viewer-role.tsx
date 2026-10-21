"use client";

/**
 * The signed-in admin's role, handed down from the shell layout (which already
 * reads it server-side for SideNav). UI hint only: the API routes enforce the
 * real role gate. Defaults to "staff" so a page rendered outside the shell
 * hides owner-only controls rather than offering them.
 */
import { createContext, useContext, type ReactNode } from "react";

export type ViewerRole = "owner" | "staff";

const ViewerRoleContext = createContext<ViewerRole>("staff");

export function ViewerRoleProvider({ role, children }: { role: ViewerRole; children: ReactNode }) {
  return <ViewerRoleContext.Provider value={role}>{children}</ViewerRoleContext.Provider>;
}

export function useViewerRole(): ViewerRole {
  return useContext(ViewerRoleContext);
}
