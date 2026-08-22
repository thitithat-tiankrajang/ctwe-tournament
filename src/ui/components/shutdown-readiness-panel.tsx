"use client";

import { CircleCheck, CircleSlash, LoaderCircle, PackageOpen, RefreshCw, ServerCog } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import type { ShutdownReadiness } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { Panel } from "@/ui/components/page";

/**
 * "May the backend be switched off?" — architecture §19, shown to the operator who will run the
 * workflow that asks the same question.
 *
 * <p>Two things this panel deliberately does not do. It has **no stop button**: suspending is a
 * GitHub Actions dispatch, outside the application, because a process should not be the sole judge
 * of its own shutdown (§17.1). And it presents its own answer as *evidence, not permission* — the
 * workflow independently fetches every published snapshot over the public internet before it acts
 * (§19.3), and a green panel here does not authorize anything.
 */
export function ShutdownReadinessPanel({
  busy,
  onShelve,
  onError,
}: {
  busy: boolean;
  /** Opens the shared password dialog; shelving is a deliberate, attributable decision. */
  onShelve: (tournamentId: string, name: string, onDone: (readiness: ShutdownReadiness) => void) => void;
  onError: (message: string) => void;
}) {
  const loadShutdownReadiness = useTournamentStore((state) => state.loadShutdownReadiness);
  const unshelveTournament = useTournamentStore((state) => state.unshelveTournament);

  const [readiness, setReadiness] = useState<ShutdownReadiness | null>(null);
  const [working, setWorking] = useState(false);

  // `onError` arrives as an inline arrow from /admin, so it is a new function on every render of
  // that page. Depending on it directly made `refresh` — and therefore the effect below — new each
  // time, and the admin page re-renders several times while tournaments, directors, archives and one
  // snapshot status per row land. Measured: FIVE readiness requests for a single page load.
  // Same fix, same reason, as SnapshotPublicationPanel's onStatusRef/onErrorRef.
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; });

  const refresh = useCallback(async () => {
    try {
      setReadiness(await loadShutdownReadiness());
    } catch (error) {
      onErrorRef.current(error instanceof Error ? error.message : "โหลดสถานะการปิดระบบไม่สำเร็จ");
    }
  }, [loadShutdownReadiness]);

  useEffect(() => { void refresh(); }, [refresh]);

  const unshelve = async (tournamentId: string) => {
    setWorking(true);
    try {
      setReadiness(await unshelveTournament(tournamentId));
    } catch (error) {
      onError(error instanceof Error ? error.message : "ยกเลิกการพักรายการไม่สำเร็จ");
    } finally {
      setWorking(false);
    }
  };

  const disabled = busy || working;

  return (
    <Panel
      title="ความพร้อมในการปิดระบบ"
      description="ตรวจว่ามีรายการแข่งขันใดยังค้างอยู่ก่อนจะปิดเซิร์ฟเวอร์จัดการแข่งขัน — การปิดจริงทำผ่าน workflow ไม่ใช่จากหน้านี้"
    >
      <div className="panel-padding console-stack">
        {!readiness && (
          <span className="console-hint"><LoaderCircle className="loading-spinner" size={13} />กำลังตรวจสอบ…</span>
        )}

        {readiness && (
          <>
            <div className="console-row__meta">
              <span className="console-hint"><ServerCog size={14} />สถานะ:</span>
              {readiness.readyToStop
                ? <Badge tone="success"><CircleCheck size={12} />ปิดระบบได้</Badge>
                : <Badge tone="warning"><CircleSlash size={12} />ยังปิดไม่ได้</Badge>}
              <Badge tone="neutral">ยังดำเนินอยู่ {readiness.activeTournamentCount} รายการ</Badge>
              <Badge tone="neutral">เผยแพร่แล้ว {readiness.publishedSnapshots.length} ฉบับ</Badge>
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void refresh()}>
                <RefreshCw size={14} />ตรวจใหม่
              </Button>
            </div>

            {readiness.readyToStop && (
              <p className="console-note">
                · workflow จะตรวจสอบไฟล์ที่เผยแพร่ทุกฉบับผ่านอินเทอร์เน็ตสาธารณะอีกครั้งก่อนปิดระบบเสมอ
              </p>
            )}

            {readiness.unpublishedFinished.length > 0 && (
              <>
                <span className="console-hint">
                  รายการที่จบแล้วแต่ยังไม่เผยแพร่ — ต้องเผยแพร่ หรือระบุว่าจะไม่เผยแพร่:
                </span>
                {readiness.unpublishedFinished.map((blocker) => (
                  <div key={blocker.tournamentId} className="console-row__meta">
                    <strong>{blocker.name}</strong>
                    <Badge tone="neutral">{blocker.cardCount} การ์ด</Badge>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={disabled}
                      title="ระบุว่ารายการนี้จะไม่ถูกเผยแพร่ เพื่อไม่ให้ค้างการปิดระบบ (ย้อนกลับได้)"
                      onClick={() => onShelve(blocker.tournamentId, blocker.name, setReadiness)}
                    >
                      <PackageOpen size={14} />พักรายการ (จะไม่เผยแพร่)
                    </Button>
                  </div>
                ))}
              </>
            )}

            {readiness.activeTournamentCount > readiness.unpublishedFinished.length && (
              <p className="console-note">
                · ยังมีรายการที่การ์ดเล่นไม่จบ — ต้องให้จบก่อน ไม่สามารถข้ามได้แม้จะพักรายการไว้
              </p>
            )}

            {readiness.shelved.length > 0 && (
              <>
                <span className="console-hint">รายการที่ระบุว่าจะไม่เผยแพร่:</span>
                {readiness.shelved.map((shelved) => (
                  <div key={shelved.tournamentId} className="console-row__meta">
                    <span className="muted">{shelved.name}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      title="นำกลับมานับในเงื่อนไขการปิดระบบ"
                      onClick={() => void unshelve(shelved.tournamentId)}
                    >
                      ยกเลิกการพัก
                    </Button>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
