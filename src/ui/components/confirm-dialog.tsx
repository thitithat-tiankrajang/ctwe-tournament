"use client";

import { AlertTriangle, X } from "lucide-react";
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
  /** Disables the confirm button (e.g. nothing picked yet). */
  confirmDisabled?: boolean;
  cancelLabel?: string;
  error?: string;
  /** Header accent above the title. */
  eyebrow?: string;
  /** Header icon; defaults to a warning triangle. */
  icon?: ReactNode;
  /** Extra classes on the dialog box (e.g. size variants). */
  className?: string;
  appearance?: "prototype";
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
  confirmDisabled = false,
  cancelLabel = "ยกเลิก",
  error,
  eyebrow = "ตรวจสอบก่อนดำเนินการ",
  icon,
  className = "",
  appearance,
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Escape, focus trap, focus restore, scroll lock and unique ids all come from the one modal
  // behaviour; see 24_P7_DESIGN_SYSTEM.md. `busy` is what makes a dialog temporarily undismissable.
  const dialog = useModalDialog({ open, onDismiss: onCancel, dismissible: !busy });

  if (!open) return null;
  if (appearance === "prototype") return (
    <div className="scrim prototype-dialog-scrim" role="presentation" onMouseDown={dialog.onBackdropMouseDown}>
      <section ref={dialog.ref as React.RefObject<HTMLElement>} tabIndex={-1}
        className={`dialog ${danger ? "dialog--destructive" : "dialog--consequential"} ${className}`}
        role="dialog" aria-modal="true" aria-labelledby={dialog.titleId}
        aria-describedby={description ? dialog.descriptionId : undefined}
        onMouseDown={(event) => event.stopPropagation()}>
        <header className="dlg-head">
          {eyebrow && <span className="dlg-eyebrow">{icon ?? <AlertTriangle className="i" size={15} />}{eyebrow}</span>}
          <h2 id={dialog.titleId}>{title}</h2>
        </header>
        <div className="dlg-body">
          {description && <p id={dialog.descriptionId}>{description}</p>}{children}
          {error && <p className="dlg-err" role="alert">{error}</p>}
        </div>
        <footer className="dlg-foot">
          {!hideCancel && <button className="btn btn--secondary" type="button" disabled={busy} onClick={onCancel}>{cancelLabel}</button>}
          <button className={`btn ${danger ? "btn--danger" : "btn--primary"}`} type="button" disabled={busy || confirmDisabled} onClick={onConfirm}>{busy ? busyLabel : confirmLabel}</button>
        </footer>
      </section>
    </div>
  );
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
          <Button variant={danger ? "danger" : "primary"} loading={busy} loadingLabel={busyLabel} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </footer>
      </section>
    </div>
  );
}
