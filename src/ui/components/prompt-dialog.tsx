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
  error?: string;
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
  error,
  onSubmit,
  onCancel,
}: PromptDialogProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset and focus the field every time the dialog opens.
  useEffect(() => {
    setValue("");
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
  const valid = value.trim().length >= minLength;
  const submit = () => { if (valid && !busy) onSubmit(value); };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => !busy && onCancel()}>
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="prompt-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div className="confirm-dialog__icon"><KeyRound size={20} /></div>
          <div><span>ยืนยันการดำเนินการ</span><h2 id="prompt-dialog-title">{title}</h2></div>
          <button className="confirm-dialog__close" type="button" aria-label="ปิด" disabled={busy} onClick={onCancel}><X size={18} /></button>
        </header>
        {description && <p>{description}</p>}
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
          <Button disabled={busy || !valid} onClick={submit}>
            {busy && <LoaderCircle className="loading-spinner" size={16} />}{busy ? "กำลังดำเนินการ…" : confirmLabel}
          </Button>
        </footer>
      </section>
    </div>
  );
}
