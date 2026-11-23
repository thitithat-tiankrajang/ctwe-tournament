"use client";

import { LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useTournamentStore } from "@/application/tournament/store";

/**
 * The background check after the tab comes back (wake reconciliation), shown in the top bar so the
 * page below never moves: a quiet status while checking (the top bar also draws a sweeping
 * hairline through `.topbar:has(.syncind--checking)`), and a warning with retry if it failed.
 */
export function CardSyncIndicator({ cardId, compact = false }: { cardId?: string; compact?: boolean }) {
  const state = useTournamentStore((store) =>
    store.wakeReconciliation?.cardId === cardId ? store.wakeReconciliation : null);
  const reconcileCard = useTournamentStore((store) => store.reconcileCard);

  if (!state || !cardId || state.status === "verified") return null;

  if (state.status === "checking") {
    return (
      <span className="syncind syncind--checking" role="status" aria-live="polite" title="กำลังตรวจสอบการเปลี่ยนแปลงจากผู้ใช้อื่น">
        <LoaderCircle className="i spin" size={15} aria-hidden="true" />
        <span className={compact ? "sr" : "syncind__t"}>กำลังตรวจสอบข้อมูลล่าสุด</span>
      </span>
    );
  }

  return (
    <span className="syncind syncind--fail" role="alert">
      <TriangleAlert className="i" size={15} aria-hidden="true" />
      <span className={compact ? "sr" : "syncind__t"}>ยังตรวจสอบข้อมูลล่าสุดไม่ได้</span>
      <button type="button" className="btn btn--sm btn--secondary syncind__retry" aria-label="ตรวจสอบข้อมูลล่าสุดอีกครั้ง"
        onClick={() => void reconcileCard(cardId)}>
        <RefreshCw className="i" size={13} aria-hidden="true" />{compact ? null : "ลองอีกครั้ง"}
      </button>
    </span>
  );
}
