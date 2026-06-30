"use client";

import { create } from "zustand";

export type ToastTone = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastState {
  toasts: ToastItem[];
  push: (tone: ToastTone, message: string) => void;
  dismiss: (id: number) => void;
}

let counter = 0;
const AUTO_DISMISS_MS = 4_000;

/** App-wide toast notifications — our own replacement for window.alert feedback. */
export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (tone, message) => {
    const id = ++counter;
    set((state) => ({ toasts: [...state.toasts, { id, tone, message }] }));
    if (typeof window !== "undefined") {
      window.setTimeout(() => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })), AUTO_DISMISS_MS);
    }
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),
}));

export const toast = {
  success: (message: string) => useToastStore.getState().push("success", message),
  error: (message: string) => useToastStore.getState().push("error", message),
  info: (message: string) => useToastStore.getState().push("info", message),
};
