"use client";

import { AlertTriangle, LoaderCircle, X } from "lucide-react";
import { type ReactNode } from "react";
import { Button } from "@/ui/components/button";
import { useModalDialog } from "@/ui/overlay/use-modal-dialog";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Optional when the body is carried entirely by `children`. */
  description?: string;
  confirmLabel: string;
  busy?: boolean;
  /** Shown on the confirm button while busy. */
  busyLabel?: string;
  danger?: boolean;
  hideCancel?: boolean;
  cancelLabel?: string;
  error?: string;
  /** Header accent above the title. */
  eyebrow?: string;
  /** Header icon; defaults to a warning triangle. */
  icon?: ReactNode;
  /** Extra classes on the dialog box (e.g. size variants). */
  className?: string;
  /** Custom body content rendered between the description and the error/footer. */
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The one confirm-style modal for the whole app — every yes/no (plus small form) dialog uses this. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy = false,
  busyLabel = "กำลังบันทึก…",
  danger = false,
  hideCancel = false,
  cancelLabel = "ยกเลิก",
  error,
  eyebrow = "ตรวจสอบก่อนดำเนินการ",
  icon,
  className = "",
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Escape, focus trap, focus restore, scroll lock and unique ids all come from the one modal
  // behaviour; see 24_P7_DESIGN_SYSTEM.md. `busy` is what makes a dialog temporarily undismissable.
  const dialog = useModalDialog({ open, onDismiss: onCancel, dismissible: !busy });

  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={dialog.onBackdropMouseDown}>
      <section
        ref={dialog.ref as React.RefObject<HTMLElement>}
        tabIndex={-1}
        className={`confirm-dialog${danger ? " confirm-dialog--danger" : ""}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialog.titleId}
        aria-describedby={description ? dialog.descriptionId : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div className="confirm-dialog__icon">{icon ?? <AlertTriangle size={20} />}</div>
          <div><span>{eyebrow}</span><h2 id={dialog.titleId}>{title}</h2></div>
          <button className="confirm-dialog__close" type="button" aria-label="ปิด" disabled={busy} onClick={onCancel}><X size={18} /></button>
        </header>
        {description && <p id={dialog.descriptionId}>{description}</p>}
        {children}
        {error && <div className="confirm-dialog__error" role="alert">{error}</div>}
        <footer>
          {!hideCancel && <Button variant="secondary" disabled={busy} onClick={onCancel}>{cancelLabel}</Button>}
          <Button variant={danger ? "danger" : "primary"} disabled={busy} onClick={onConfirm}>
            {busy && <LoaderCircle className="loading-spinner" size={16} />}{busy ? busyLabel : confirmLabel}
          </Button>
        </footer>
      </section>
    </div>
  );
}
