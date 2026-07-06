"use client";

import { create } from "zustand";

type AlertRequest = {
  id: number;
  kind: "alert";
  title: string;
  description: string;
  danger?: boolean;
  resolve: () => void;
};

type ConfirmRequest = {
  id: number;
  kind: "confirm";
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  resolve: (confirmed: boolean) => void;
};

type PromptRequest = {
  id: number;
  kind: "prompt";
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  type?: "text" | "password";
  confirmLabel: string;
  minLength?: number;
  resolve: (value: string | null) => void;
};

export type AppDialogRequest = AlertRequest | ConfirmRequest | PromptRequest;

interface DialogState {
  queue: AppDialogRequest[];
  enqueue: (request: AppDialogRequest) => void;
  shift: () => void;
}

export const useDialogStore = create<DialogState>((set) => ({
  queue: [],
  enqueue: (request) => set((state) => ({ queue: [...state.queue, request] })),
  shift: () => set((state) => ({ queue: state.queue.slice(1) })),
}));

let dialogId = 0;

export const appDialog = {
  alert(description: string, title = "แจ้งเตือน", danger = false) {
    return new Promise<void>((resolve) => {
      useDialogStore.getState().enqueue({ id: ++dialogId, kind: "alert", title, description, danger, resolve });
    });
  },
  confirm(
    description: string,
    options: { title?: string; confirmLabel?: string; danger?: boolean } = {},
  ) {
    return new Promise<boolean>((resolve) => {
      useDialogStore.getState().enqueue({
        id: ++dialogId,
        kind: "confirm",
        title: options.title ?? "ยืนยันการดำเนินการ",
        description,
        confirmLabel: options.confirmLabel ?? "ยืนยัน",
        danger: options.danger,
        resolve,
      });
    });
  },
  prompt(
    description: string,
    options: {
      title?: string;
      label?: string;
      placeholder?: string;
      type?: "text" | "password";
      confirmLabel?: string;
      minLength?: number;
    } = {},
  ) {
    return new Promise<string | null>((resolve) => {
      useDialogStore.getState().enqueue({
        id: ++dialogId,
        kind: "prompt",
        title: options.title ?? "กรอกข้อมูลเพื่อดำเนินการ",
        description,
        label: options.label ?? "ข้อมูล",
        placeholder: options.placeholder,
        type: options.type,
        confirmLabel: options.confirmLabel ?? "ยืนยัน",
        minLength: options.minLength,
        resolve,
      });
    });
  },
};
