"use client";

import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useState, type InputHTMLAttributes } from "react";

export interface FreshSecretInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "autoComplete" | "value"> {
  value: string;
  wrapperClassName?: string;
}

/**
 * A masked, text-backed secret field that is deliberately invisible to browser
 * password-saving heuristics. Secrets remain controlled by the owning component
 * and are never offered for autofill or persistence. The eye button toggles the
 * mask so long passwords can be verified before submitting.
 */
export const FreshSecretInput = forwardRef<HTMLInputElement, FreshSecretInputProps>(function FreshSecretInput(
  { className = "", wrapperClassName = "", value, ...props },
  ref,
) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span className={`fresh-secret-input${revealed ? " fresh-secret-input--revealed" : ""}${wrapperClassName ? ` ${wrapperClassName}` : ""}`}>
      <input
        {...props}
        ref={ref}
        className={`${className} fresh-secret-input__control`}
        type="text"
        value={value}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore
        data-bwignore="true"
        data-form-type="other"
        data-lpignore="true"
        data-protonpass-ignore="true"
      />
      {!revealed && <span className="fresh-secret-input__mask" aria-hidden="true">{"•".repeat(Array.from(value).length)}</span>}
      <button
        type="button"
        className="fresh-secret-input__toggle"
        tabIndex={-1}
        aria-label={revealed ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
        title={revealed ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
        disabled={props.disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setRevealed((current) => !current)}
      >
        {revealed ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
      </button>
    </span>
  );
});
