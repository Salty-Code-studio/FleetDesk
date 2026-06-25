"use client";

import type { ReactNode } from "react";
import { ToastProvider } from "./Toast";
import { ConfirmProvider } from "./ConfirmDialog";
import { CommandPalette } from "./CommandPalette";

/**
 * Client wrapper that supplies the shared admin UX context to every shell page:
 *   - ToastProvider .... useToast() works anywhere under the shell
 *   - ConfirmProvider .. useConfirm() promise-based confirmations
 *   - CommandPalette ... global Cmd/Ctrl+K surface, mounted once
 *
 * The (shell) layout is a Server Component, so this client boundary is what lets
 * those providers and the palette live around {children} and the topbar.
 *
 * `fontVars` carries the self-hosted next/font variable classes
 * (--font-display / --font-mono / --font-body) computed in the server layout.
 * It is applied to THIS root wrapper, which encloses both {children} (the
 * .shell) AND the overlay surfaces the providers render (toaster, confirm
 * Modal, CommandPalette). Without it, those overlays would sit outside the
 * font-variable scope and fall back to the literal family stack, so the modal
 * title, drawer title, palette text, empty-state and toast labels would render
 * in system-ui instead of the self-hosted Space Grotesk / JetBrains Mono used
 * everywhere else in admin.
 */
export function AdminChrome({
  children,
  fontVars = "",
}: {
  children: ReactNode;
  fontVars?: string;
}) {
  return (
    <div className={fontVars}>
      <ToastProvider>
        <ConfirmProvider>
          {children}
          <CommandPalette />
        </ConfirmProvider>
      </ToastProvider>
    </div>
  );
}
