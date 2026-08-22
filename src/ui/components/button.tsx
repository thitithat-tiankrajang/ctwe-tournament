import { LoaderCircle } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "danger" | "success" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  /**
   * An action is in flight: shows the spinner and disables the button, so a second click cannot
   * fire the same mutation twice. Pass `loadingLabel` to swap the text as well.
   *
   * This exists because every caller was writing the same three things by hand — the spinner, the
   * label swap, and remembering to disable — and forgetting the third is a double-submit.
   */
  loading?: boolean;
  /** Replaces the children while `loading`. Omit to keep the normal label beside the spinner. */
  loadingLabel?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className = "", variant = "primary", size = "md", loading = false, loadingLabel, children, disabled, ...props },
  ref,
) {
  // `md` is the default and has no rule of its own; emitting `button--md` produced a class that
  // matched nothing in the stylesheet.
  const sizeClass = size === "md" ? "" : ` button--${size}`;
  return (
    <button
      ref={ref}
      className={`button button--${variant}${sizeClass} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <LoaderCircle className="loading-spinner" size={16} aria-hidden />}
      {loading && loadingLabel !== undefined ? loadingLabel : children}
    </button>
  );
});
