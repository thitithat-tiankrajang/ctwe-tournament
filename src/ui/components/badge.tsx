import type { ReactNode } from "react";

const statusTone: Record<string, string> = {
  DRAFT: "neutral",
  READY: "info",
  RUNNING: "warning",
  FINISHED: "success",
  CLOSED: "danger",
  OPEN: "warning",
  COMPLETED: "success",
  PENDING: "neutral",
};

export function Badge({ children, tone }: { children: ReactNode; tone?: "neutral" | "info" | "warning" | "success" | "danger" }) {
  const resolved = tone ?? statusTone[String(children)] ?? "neutral";
  return <span className={`badge badge--${resolved}`}>{children}</span>;
}
