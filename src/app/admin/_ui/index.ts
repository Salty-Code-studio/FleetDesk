/**
 * FleetDesk admin modern-UI kit (Sand & Surf). Build once, consumed by every
 * admin section. All pieces are presentation + interaction shell only and pass
 * the strict UI CSP (plain React, next/font, inline styles + scoped CSS in
 * admin.css; no eval, no external loads).
 *
 * Consume via:  import { Modal, useToast } from "@/app/admin/_ui";
 */
export { Modal } from "./Modal";
export type { ModalProps, ModalSize } from "./Modal";

export { Drawer } from "./Drawer";
export type { DrawerProps, DrawerSize } from "./Drawer";

export { ToastProvider, useToast } from "./Toast";
export type { ToastApi, ToastOptions, ToastType } from "./Toast";

export { useUndo, undoToast } from "./undo";

export { ConfirmProvider, useConfirm } from "./ConfirmDialog";
export type { ConfirmFn, ConfirmOptions } from "./ConfirmDialog";

export { Skeleton, SkeletonRows } from "./Skeleton";
export type { SkeletonProps } from "./Skeleton";

export { EmptyState } from "./EmptyState";
export type { EmptyStateProps } from "./EmptyState";

export {
  CommandPalette,
  openCommandPalette,
  registerPaletteAction,
} from "./CommandPalette";
export type { PaletteAction } from "./CommandPalette";

export { AdminChrome } from "./AdminChrome";
