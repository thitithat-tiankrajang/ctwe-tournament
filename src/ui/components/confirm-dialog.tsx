"use client";

import { AlertTriangle, LoaderCircle, X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/ui/components/button";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy = false,
  danger = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onCancel, open]);

  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => !busy && onCancel()}>
      <section
        className={`confirm-dialog${danger ? " confirm-dialog--danger" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div className="confirm-dialog__icon"><AlertTriangle size={20} /></div>
          <div><span>ตรวจสอบก่อนดำเนินการ</span><h2 id="confirm-dialog-title">{title}</h2></div>
          <button className="confirm-dialog__close" type="button" aria-label="ปิด" disabled={busy} onClick={onCancel}><X size={18} /></button>
        </header>
        <p id="confirm-dialog-description">{description}</p>
        {error && <div className="confirm-dialog__error" role="alert">{error}</div>}
        <footer>
          <Button variant="secondary" disabled={busy} onClick={onCancel}>ยกเลิก</Button>
          <Button variant={danger ? "danger" : "primary"} disabled={busy} onClick={onConfirm}>
            {busy && <LoaderCircle className="loading-spinner" size={16} />}{busy ? "กำลังบันทึก…" : confirmLabel}
          </Button>
        </footer>
      </section>
    </div>
  );
}
