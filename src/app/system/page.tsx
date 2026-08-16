"use client";

import { CircleHelp, PowerOff, RefreshCw, ServerCog } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  fetchSystemState,
  resetSystemStateCache,
  type SystemState,
} from "@/infrastructure/http/system-state";
import { Button } from "@/ui/components/button";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";
import { Badge, type BadgeTone } from "@/ui/components/badge";

/**
 * The public status page for zero-compute mode — architecture Z1.
 *
 * It reads `system/state.json` from the snapshot origin and renders it. That is the whole page: no
 * backend call, no authentication, nothing that stops working when Spring Boot does. Anyone
 * wondering "is it me, or is the system down?" can answer it here while the backend is suspended.
 *
 * **It reports; it controls nothing (§17.5).** Starting and stopping is a GitHub Actions dispatch by
 * an operator with repository access, and the file is written by that workflow as the single writer.
 */
const STATE_COPY: Record<SystemState["state"], { title: string; english: string; tone: BadgeTone }> = {
  OFF: { title: "ระบบปิดอยู่", english: "System is off — no tournament is being run.", tone: "neutral" },
  STARTING: { title: "กำลังเริ่มระบบ", english: "System is starting up.", tone: "warning" },
  READY: { title: "ระบบพร้อมใช้งาน", english: "System is running.", tone: "success" },
  DRAINING: { title: "กำลังเตรียมปิดระบบ", english: "Winding down — still available.", tone: "warning" },
  STOPPING: { title: "กำลังปิดระบบ", english: "System is shutting down.", tone: "warning" },
};

export default function SystemStatusPage() {
  const [state, setState] = useState<SystemState | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoaded(false);
    resetSystemStateCache();
    setState(await fetchSystemState());
    setLoaded(true);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const copy = state ? STATE_COPY[state.state] : null;

  return (
    <>
      <PageHeader
        eyebrow="System status"
        title="สถานะระบบจัดการแข่งขัน"
        description="ผลการแข่งขันที่เผยแพร่แล้วเปิดดูได้เสมอ ไม่ว่าระบบจัดการแข่งขันจะเปิดอยู่หรือไม่"
      />
      <Panel title="สถานะปัจจุบัน" description="อ่านจากไฟล์สถานะบน CDN — ไม่ต้องพึ่งเซิร์ฟเวอร์จัดการแข่งขัน">
        <div className="panel-padding console-stack">
          {!loaded && <p className="muted">กำลังตรวจสอบ…</p>}

          {loaded && state && copy && (
            <>
              <div className="console-row__meta">
                <span className="console-hint">
                  {state.state === "OFF" ? <PowerOff size={14} /> : <ServerCog size={14} />}สถานะ:
                </span>
                <Badge tone={copy.tone}>{copy.title}</Badge>
                <span className="muted">{copy.english}</span>
              </div>
              {state.message && <p className="console-note">· {state.message}</p>}
              {state.since && (
                <p className="console-note">· ตั้งแต่ {new Date(state.since).toLocaleString("th-TH")}</p>
              )}
              {state.activeTournamentsAtLastCheck !== null && (
                <p className="console-note">
                  · รายการแข่งขันที่ยังดำเนินอยู่เมื่อตรวจสอบล่าสุด: {state.activeTournamentsAtLastCheck}
                </p>
              )}
            </>
          )}

          {loaded && !state && (
            <EmptyState
              icon={<CircleHelp size={25} />}
              title="ไม่ทราบสถานะ"
              description="ยังไม่มีไฟล์สถานะ หรืออ่านไม่ได้ในขณะนี้ — หากเข้าใช้งานระบบได้ตามปกติ แสดงว่าระบบยังทำงานอยู่"
            />
          )}

          <div className="form-actions form-actions--flush">
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              <RefreshCw size={14} />ตรวจสอบอีกครั้ง
            </Button>
          </div>
        </div>
      </Panel>
    </>
  );
}
