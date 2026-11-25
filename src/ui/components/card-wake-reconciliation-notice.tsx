"use client";

import { LoaderCircle, RefreshCw } from "lucide-react";
import { useTournamentStore } from "@/application/tournament/store";
import { Button } from "./button";

export function CardWakeReconciliationNotice({ cardId }: { cardId?: string }) {
  const state = useTournamentStore((store) =>
    store.wakeReconciliation?.cardId === cardId ? store.wakeReconciliation : null);
  const reconcileCard = useTournamentStore((store) => store.reconcileCard);

  if (!state || !cardId || state.status === "verified") return null;

  if (state.status === "checking") {
    return (
      <div className="notice notice--info" role="status" aria-live="polite">
        <LoaderCircle className="loading-spinner" size={18} aria-hidden="true" />
        <p>
          <strong>กำลังตรวจสอบข้อมูลล่าสุด</strong>
          <span>กำลังตรวจสอบการเปลี่ยนแปลงจากผู้ใช้อื่น</span>
        </p>
      </div>
    );
  }

  return (
    <div className="notice notice--warning" role="alert">
      <p>
        <strong>ยังตรวจสอบข้อมูลล่าสุดไม่ได้</strong>
        <span>ข้อมูลบนหน้านี้อาจยังไม่เป็นปัจจุบัน</span>
      </p>
      <Button size="sm" variant="secondary" onClick={() => void reconcileCard(cardId)}>
        <RefreshCw size={15} aria-hidden="true" />
        ลองอีกครั้ง
      </Button>
    </div>
  );
}
