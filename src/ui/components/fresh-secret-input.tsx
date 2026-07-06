"use client";

import { forwardRef, type InputHTMLAttributes } from "react";

export interface FreshSecretInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "autoComplete" | "value"> {
  value: string;
  wrapperClassName?: string;
}

/**
 * A masked, text-backed secret field that is deliberately invisible to browser
 * password-saving heuristics. Secrets remain controlled by the owning component
 * and are never offered for autofill or persistence.
 */
export const FreshSecretInput = forwardRef<HTMLInputElement, FreshSecretInputProps>(function FreshSecretInput(
  { className = "", wrapperClassName = "", value, ...props },
  ref,
) {
  return (
    <span className={`fresh-secret-input${wrapperClassName ? ` ${wrapperClassName}` : ""}`}>
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
      <span className="fresh-secret-input__mask" aria-hidden="true">{"•".repeat(Array.from(value).length)}</span>
    </span>
  );
});
