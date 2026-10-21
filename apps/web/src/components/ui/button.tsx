import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export function buttonClassName(variant: ButtonVariant = "primary", className = "") {
  return `button button--${variant} ${className}`;
}
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean };
export function Button({ variant = "primary", loading = false, disabled, className, children, type = "button", ...props }: ButtonProps) {
  return <button {...props} type={type} className={buttonClassName(variant, className)} disabled={disabled || loading} aria-busy={loading || undefined}>
    {loading && <span className="spinner" aria-hidden="true" />}{children}
  </button>;
}
export function IconButton({ label, children, className = "", ...props }: ButtonProps & { label: string }) {
  return <Button {...props} aria-label={label} title={label} className={`icon-button ${className}`}>{children}</Button>;
}
