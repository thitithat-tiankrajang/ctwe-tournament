"use client";

import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useState, type InputHTMLAttributes } from "react";

export interface FreshSecretInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "autoComplete" | "value"> {
  value: string;
  wrapperClassName?: string;
}

/**
 * A masked secret field. Secrets stay controlled by the owning component; the eye button toggles
 * the mask so a long password can be checked before submitting.
 *
 * The field is `type="password"` while masked and `type="text"` only once the operator has asked
 * to see it. That is D6's fix: the previous version was `type="text"` always, masked purely by
 * `-webkit-text-security` in CSS — which hides the characters from the screen but not from the
 * accessibility tree, so a screen reader read the password out. CSS masking is not masking.
 *
 * The trade this makes, and it is a real one: `type="password"` is also what browser password
 * managers key on, and avoiding them was the original reason this component existed. Every
 * suppression signal available is kept below — the per-manager ignore attributes cover 1Password,
 * Bitwarden, LastPass and Proton, and `new-password` is the strongest standard hint (`off` is
 * ignored for password fields). None of them binds Chrome's or Safari's built-in "save password?"
 * prompt. On the shared venue machines of D6/D9 that prompt is the residual risk; see the P6
 * closure. Reverting is one expression on the `type` line.
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
        type={revealed ? "text" : "password"}
        value={value}
        autoComplete="new-password"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore
        data-bwignore="true"
        data-form-type="other"
        data-lpignore="true"
        data-protonpass-ignore="true"
      />
      {/* A toggle button, so it carries its state rather than renaming itself: a screen reader
          announces "แสดงรหัสผ่าน, ปุ่มสลับ, ถูกกด" the moment it is pressed, instead of only
          describing the next action the next time the control is reached. `title` stays dynamic —
          it is a pointer tooltip for the action, not the accessible name. */}
      <button
        type="button"
        className="fresh-secret-input__toggle"
        aria-label="แสดงรหัสผ่าน"
        aria-pressed={revealed}
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
