"use client";

import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useToastStore } from "@/application/ui/toast";

const ICONS = {
  success: <CheckCircle2 size={18} />,
  error: <AlertTriangle size={18} />,
  info: <Info size={18} />,
};

/** Fixed-position stack of app toasts. Rendered once near the app root. */
export function Toaster() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className="toaster" aria-live="polite" aria-atomic="false">
      {toasts.map((item) => (
        <div key={item.id} className={`toast toast--${item.tone}`} role="status">
          <span className="toast__icon">{ICONS[item.tone]}</span>
          <span className="toast__message">{item.message}</span>
          <button type="button" className="toast__close" aria-label="ปิดการแจ้งเตือน" onClick={() => dismiss(item.id)}><X size={15} /></button>
        </div>
      ))}
    </div>
  );
}
