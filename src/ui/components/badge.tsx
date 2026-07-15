import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "info" | "warning" | "success" | "danger";

/** Tone is always explicit — no guessing from the label text, which broke silently when copy changed. */
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}
