"use client";

import { KeyRound, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/ui/components/button";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";

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

  // Reset and focus the field every time the dialog opens.
  useEffect(() => {
    setValue("");
    setPhrase("");
    if (!open) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel, open]);

  if (!open) return null;
  const phraseSatisfied = !confirmationPhrase || phrase.trim() === confirmationPhrase.trim();
  const valid = value.trim().length >= minLength && phraseSatisfied;
  const submit = () => { if (valid && !busy) onSubmit(value); };
  const submitSecondary = () => { if (valid && !busy && onSecondarySubmit) onSecondarySubmit(value); };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => !busy && onCancel()}>
      <section className={`confirm-dialog${danger ? " confirm-dialog--danger" : ""}`} role="dialog" aria-modal="true" aria-labelledby="prompt-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div className="confirm-dialog__icon"><KeyRound size={20} /></div>
          <div><span>{eyebrow}</span><h2 id="prompt-dialog-title">{title}</h2></div>
          <button className="confirm-dialog__close" type="button" aria-label="ปิด" disabled={busy} onClick={onCancel}><X size={18} /></button>
        </header>
        {description && <p>{description}</p>}
        {confirmationPhrase && (
          <>
            <label className="form-label" htmlFor="prompt-dialog-phrase">
              {confirmationLabel ?? `พิมพ์ "${confirmationPhrase}" เพื่อยืนยัน`}
            </label>
            <input
              id="prompt-dialog-phrase"
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
        <label className="form-label" htmlFor="prompt-dialog-input">{label}</label>
        {type === "password" ? (
          <FreshSecretInput
            ref={inputRef}
            id="prompt-dialog-input"
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
            id="prompt-dialog-input"
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
        {error && <div className="confirm-dialog__error" role="alert">{error}</div>}
        <footer>
          <Button variant="secondary" disabled={busy} onClick={onCancel}>ยกเลิก</Button>
          {secondaryConfirmLabel && onSecondarySubmit && (
            <Button variant="secondary" disabled={busy || !valid} onClick={submitSecondary}>
              {secondaryConfirmLabel}
            </Button>
          )}
          <Button disabled={busy || !valid} onClick={submit}>
            {busy && <LoaderCircle className="loading-spinner" size={16} />}{busy ? "กำลังดำเนินการ…" : confirmLabel}
          </Button>
        </footer>
      </section>
    </div>
  );
}
