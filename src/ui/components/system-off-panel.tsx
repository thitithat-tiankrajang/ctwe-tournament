"use client";

import { PowerOff } from "lucide-react";
import type { SystemState } from "@/infrastructure/http/system-state";

/**
 * The bilingual "system is off" message — architecture §21.
 *
 * One component rather than three copies of the copy, because the login page, the landing page and
 * the viewer must all say the same thing: the organizing system is not running, and **published
 * results are unaffected**. That second sentence is the important one — it is the whole promise of
 * zero-compute mode, and a panel that only said "system off" would read as an outage.
 */
export function SystemOffPanel({ state, children }: { state: SystemState; children?: React.ReactNode }) {
  return (
    <div className="panel panel-padding console-stack" role="status">
      <strong className="console-row__title"><PowerOff size={18} />ระบบจัดการแข่งขันปิดอยู่</strong>
      <p className="muted">System is off — no tournament is being run.</p>
      <p>ผลการแข่งขันที่เผยแพร่แล้วยังเปิดดูได้ตามปกติ</p>
      <p className="muted">Published results remain available.</p>
      {state.message && <p className="console-note">· {state.message}</p>}
      {state.since && (
        <p className="console-note">
          · ตั้งแต่ {new Date(state.since).toLocaleString("th-TH")}
        </p>
      )}
      {children}
    </div>
  );
}
