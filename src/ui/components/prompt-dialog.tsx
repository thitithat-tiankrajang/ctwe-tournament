"use client";

import { KeyRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/ui/components/button";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";
import { useModalDialog } from "@/ui/overlay/use-modal-dialog";

interface PromptDialogProps {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  type?: "text" | "password";
  confirmLabel: string;
  minLength?: number;
  busy?: boolean;
  danger?: boolean;
  /** Header accent above the title. */
  eyebrow?: string;
  appearance?: "prototype";
  /**
   * Type-to-confirm guard for irreversible actions. When set, an extra text field appears and the
   * dialog cannot be submitted until the operator retypes this exact phrase (trimmed). The phrase is
   * validated here only — `onSubmit` still receives the main input's value.
   */
  confirmationPhrase?: string;
  /** Label for the type-to-confirm field; only used together with `confirmationPhrase`. */
  confirmationLabel?: string;
  error?: string;
  /**
   * Optional second confirm action shown beside the primary one, for a choice that shares this
   * dialog's input — architecture §4.6's one-click "close and retract". It obeys the same validity
   * gating as the primary button, so neither can run on an unconfirmed form.
   */
  secondaryConfirmLabel?: string;
  onSecondarySubmit?: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** Our own single-input modal — replaces window.prompt for passwords and short text entry. */
export function PromptDialog({
  open,
  title,
  description,
  label,
  placeholder,
  type = "text",
  confirmLabel,
  minLength = 1,
  busy = false,
  danger = false,
  eyebrow = "ยืนยันการดำเนินการ",
  appearance,
  confirmationPhrase,
  confirmationLabel,
  error,
  secondaryConfirmLabel,
  onSecondarySubmit,
  onSubmit,
  onCancel,
}: PromptDialogProps) {
  const [value, setValue] = useState("");
  const [phrase, setPhrase] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // The shared modal behaviour supplies Escape, the focus trap, focus restore, the scroll lock and
  // unique ids. The field focus below stays local: a prompt's first stop is its input, not the
  // close button that the generic "first focusable" rule would pick.
  const dialog = useModalDialog({ open, onDismiss: onCancel, dismissible: !busy });

  // Reset and focus the field every time the dialog opens.
  useEffect(() => {
    setValue("");
    setPhrase("");
    if (!open) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open) return null;
  const phraseSatisfied = !confirmationPhrase || phrase.trim() === confirmationPhrase.trim();
  const valid = value.trim().length >= minLength && phraseSatisfied;
  const submit = () => { if (valid && !busy) onSubmit(value); };
  const submitSecondary = () => { if (valid && !busy && onSecondarySubmit) onSecondarySubmit(value); };

  const prototype = appearance === "prototype";
  const inputId = `${dialog.titleId}-input`;
  const phraseId = `${dialog.titleId}-phrase`;
  const fields = <>
        {description && <p id={dialog.descriptionId}>{description}</p>}
        {confirmationPhrase && (
          <>
            <label className="form-label" htmlFor={phraseId}>
              {confirmationLabel ?? `พิมพ์ "${confirmationPhrase}" เพื่อยืนยัน`}
            </label>
            <input
              id={phraseId}
              className="input"
              type="text"
              value={phrase}
              placeholder={confirmationPhrase}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setPhrase(event.target.value)}
            />
          </>
        )}
        <label className="form-label" htmlFor={inputId}>{label}</label>
        {type === "password" ? (
          <FreshSecretInput
            ref={inputRef}
            id={inputId}
            className="input"
            value={value}
            placeholder={placeholder}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } }}
          />
        ) : (
          <input
            ref={inputRef}
            id={inputId}
            className="input"
            type="text"
            value={value}
            placeholder={placeholder}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } }}
          />
        )}
        {error && <div className={prototype ? "dlg-err" : "confirm-dialog__error"} role="alert">{error}</div>}
  </>;

  return (
    <div className={prototype ? "scrim prototype-dialog-scrim" : "dialog-backdrop"} role="presentation" onMouseDown={dialog.onBackdropMouseDown}>
      <section ref={dialog.ref as React.RefObject<HTMLElement>} tabIndex={-1}
        className={prototype ? `dialog ${danger ? "dialog--destructive" : "dialog--consequential"}` : `confirm-dialog${danger ? " confirm-dialog--danger" : ""}`}
        role="dialog" aria-modal="true" aria-labelledby={dialog.titleId} aria-describedby={description ? dialog.descriptionId : undefined} onMouseDown={(event) => event.stopPropagation()}>
        {prototype ? <header className="dlg-head">
          <span className="dlg-eyebrow"><KeyRound size={15} />{eyebrow}</span><h2 id={dialog.titleId}>{title}</h2>
        </header> : <header>
          <div className="confirm-dialog__icon"><KeyRound size={20} /></div>
          <div><span>{eyebrow}</span><h2 id={dialog.titleId}>{title}</h2></div>
          <button className="confirm-dialog__close" type="button" aria-label="ปิด" disabled={busy} onClick={onCancel}><X size={18} /></button>
        </header>}
        {prototype ? <div className="dlg-body">{fields}</div> : fields}
        {prototype ? <footer className="dlg-foot">
          <button className="btn btn--secondary" type="button" disabled={busy} onClick={onCancel}>ยกเลิก</button>
          {secondaryConfirmLabel && onSecondarySubmit && <button className="btn btn--secondary" type="button" disabled={busy || !valid} onClick={submitSecondary}>{secondaryConfirmLabel}</button>}
          <button className={`btn ${danger ? "btn--danger" : "btn--primary"}`} type="button" disabled={busy || !valid} onClick={submit}>{busy ? "กำลังดำเนินการ…" : confirmLabel}</button>
        </footer> : (
        <footer>
          <Button variant="secondary" disabled={busy} onClick={onCancel}>ยกเลิก</Button>
          {secondaryConfirmLabel && onSecondarySubmit && (
            <Button variant="secondary" disabled={busy || !valid} onClick={submitSecondary}>
              {secondaryConfirmLabel}
            </Button>
          )}
          <Button disabled={!valid} loading={busy} loadingLabel="กำลังดำเนินการ…" onClick={submit}>
            {confirmLabel}
          </Button>
        </footer>)}
      </section>
    </div>
  );
}
