"use client";

import { useDialogStore } from "@/application/ui/dialog";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { PromptDialog } from "@/ui/components/prompt-dialog";

/** One app-wide queue for confirmations, password prompts, and blocking messages. */
export function GlobalDialogHost() {
  const request = useDialogStore((state) => state.queue[0]);
  const shift = useDialogStore((state) => state.shift);
  if (!request) return null;

  if (request.kind === "prompt") {
    const close = (value: string | null) => { request.resolve(value); shift(); };
    return (
      <PromptDialog
        key={request.id}
        open
        title={request.title}
        description={request.description}
        label={request.label}
        placeholder={request.placeholder}
        type={request.type}
        confirmLabel={request.confirmLabel}
        minLength={request.minLength}
        onSubmit={(value) => close(value)}
        onCancel={() => close(null)}
      />
    );
  }

  if (request.kind === "alert") {
    const close = () => { request.resolve(); shift(); };
    return (
      <ConfirmDialog
        open
        title={request.title}
        description={request.description}
        confirmLabel="รับทราบ"
        danger={request.danger}
        hideCancel
        onConfirm={close}
        onCancel={close}
      />
    );
  }

  const close = (confirmed: boolean) => { request.resolve(confirmed); shift(); };
  return (
    <ConfirmDialog
      open
      title={request.title}
      description={request.description}
      confirmLabel={request.confirmLabel}
      danger={request.danger}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  );
}
