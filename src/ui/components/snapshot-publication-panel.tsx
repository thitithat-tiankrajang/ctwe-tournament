"use client";

import { CheckCircle2, CloudOff, CloudUpload, ExternalLink, LoaderCircle, ShieldCheck, ShieldX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import type { PublicSnapshotStatus, Tournament } from "@/domain/tournament/types";
import { Badge, type BadgeTone } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { ACKNOWLEDGMENT_REV, SnapshotAcknowledgment } from "@/ui/components/snapshot-acknowledgment";

/** Publication state → how it should read at a glance. */
const STATE_LABEL: Record<PublicSnapshotStatus["state"], { text: string; tone: BadgeTone }> = {
  NOT_PUBLISHED: { text: "ยังไม่เผยแพร่", tone: "neutral" },
  APPROVED: { text: "อนุมัติแล้ว รอเผยแพร่", tone: "info" },
  PUBLISHING: { text: "กำลังเผยแพร่…", tone: "warning" },
  PUBLISHED: { text: "เผยแพร่แล้ว", tone: "success" },
  PUBLISH_FAILED: { text: "เผยแพร่ไม่สำเร็จ", tone: "danger" },
  RETRACTED: { text: "ถอนการเผยแพร่แล้ว", tone: "danger" },
};

interface Props {
  tournament: Tournament;
  busy: boolean;
  /** Opens the shared password + type-the-name dialog. */
  onApprove: (tournament: Tournament, onDone: (status: PublicSnapshotStatus) => void) => void;
  onError: (message: string) => void;
  /** Lets the console warn at close time that a published snapshot exists (§4.6). */
  onStatus?: (tournamentId: string, status: PublicSnapshotStatus) => void;
}

/**
 * The admin surface for one tournament's Public Snapshot — architecture §4.1's two steps, made
 * visible: approve, then publish.
 *
 * <p>Status is loaded on demand rather than for every row on mount. This console lists every
 * tournament, and the entire point of the snapshot project is to stop making the origin answer
 * requests nobody asked for.
 *
 * <p>The two actions are deliberately not styled alike. Approving is the weighty, attributable step
 * and carries the acknowledgment text with it; publishing afterwards is mechanical. Neither is
 * `danger` — that colour belongs to Excel Export &amp; Purge, which deletes data (§5.3 G5).
 */
export function SnapshotPublicationPanel({ tournament, busy, onApprove, onError, onStatus }: Props) {
  const loadSnapshotStatus = useTournamentStore((state) => state.loadSnapshotStatus);
  const revokeSnapshotApproval = useTournamentStore((state) => state.revokeSnapshotApproval);
  const publishSnapshot = useTournamentStore((state) => state.publishSnapshot);
  const retractSnapshot = useTournamentStore((state) => state.retractSnapshot);

  const [status, setStatus] = useState<PublicSnapshotStatus | null>(null);
  const [working, setWorking] = useState(false);

  // The console passes these as inline arrows, so their identity changes on every parent render.
  // Held in refs rather than depended on: reporting a status calls back into the parent, which
  // re-renders this row, and a load effect keyed on callback identity would then schedule another
  // load — one request storm per mounted row, forever.
  const onStatusRef = useRef(onStatus);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onStatusRef.current = onStatus;
    onErrorRef.current = onError;
  });

  const publish = useCallback((next: PublicSnapshotStatus) => {
    setStatus(next);
    onStatusRef.current?.(tournament.id, next);
  }, [tournament.id]);

  const refresh = useCallback(async () => {
    try {
      publish(await loadSnapshotStatus(tournament.id));
    } catch (error) {
      onErrorRef.current(error instanceof Error ? error.message : "โหลดสถานะฉบับเผยแพร่ไม่สำเร็จ");
    }
  }, [loadSnapshotStatus, tournament.id, publish]);

  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (action: () => Promise<PublicSnapshotStatus>) => {
    setWorking(true);
    try {
      publish(await action());
    } catch (error) {
      onError(error instanceof Error ? error.message : "ดำเนินการไม่สำเร็จ");
      void refresh();
    } finally {
      setWorking(false);
    }
  };

  if (!status) {
    return (
      <div className="console-row__meta">
        <span className="console-hint"><LoaderCircle className="loading-spinner" size={13} />กำลังโหลดสถานะฉบับเผยแพร่…</span>
      </div>
    );
  }

  const label = STATE_LABEL[status.state] ?? STATE_LABEL.NOT_PUBLISHED;
  const blocked = status.unfinishedCardCount > 0 || status.cardCount === 0;
  const disabled = busy || working;

  return (
    <div className="console-row__meta console-stack">
      <div className="console-row__meta">
        <span className="console-hint"><CloudUpload size={13} />ฉบับเผยแพร่สาธารณะ:</span>
        <Badge tone={label.tone}>{label.text}</Badge>
        {status.state === "PUBLISHED" && <Badge tone="neutral">ฉบับที่ {status.version}</Badge>}
        <Badge tone={status.approval.valid ? "success" : "neutral"}>
          {status.approval.valid ? <ShieldCheck size={12} /> : <ShieldX size={12} />}
          {status.approval.reason}
        </Badge>
        {status.publicUrl && status.state === "PUBLISHED" && (
          <a href={status.publicUrl} target="_blank" rel="noreferrer">
            <Button variant="ghost" size="sm" disabled={disabled} title="เปิดไฟล์ที่เผยแพร่">
              <ExternalLink size={14} />เปิดฉบับเผยแพร่
            </Button>
          </a>
        )}
      </div>

      {!status.storageConfigured && (
        <p className="console-note">
          · ยังไม่ได้ตั้งค่าที่เก็บไฟล์ (app.snapshot-storage.*) — อนุมัติได้ แต่ยังเผยแพร่ไม่ได้
        </p>
      )}
      {blocked && (
        <p className="console-note">
          · {status.cardCount === 0
            ? "ยังไม่มีการ์ดในรายการนี้"
            : `ยังมีการ์ดที่ยังไม่จบ ${status.unfinishedCardCount} ใบ — ต้องให้ทุกการ์ดจบก่อนจึงจะเผยแพร่ได้`}
        </p>
      )}
      {status.approval.approvedBy && (
        <p className="console-note">
          · อนุมัติโดย <strong>{status.approval.approvedBy}</strong>
          {status.approval.expiresAt && <> · หมดอายุ {new Date(status.approval.expiresAt).toLocaleString("th-TH")}</>}
        </p>
      )}

      {status.state === "RETRACTED" && (
        <p className="console-note">
          · ถอนการเผยแพร่แล้ว — ไฟล์สาธารณะถูกลบออกจาก CDN ส่วนสำเนาที่ถูกดาวน์โหลดไปก่อนหน้านี้เรียกคืนไม่ได้
        </p>
      )}
      {!status.approval.valid && status.state !== "RETRACTED" && <SnapshotAcknowledgment />}

      <div className="form-actions form-actions--flush">
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          title="บันทึกการยินยอมให้เผยแพร่ข้อมูลนี้ต่อสาธารณะอย่างถาวร"
          onClick={() => onApprove(tournament, publish)}
        >
          <CheckCircle2 size={14} />{status.approval.valid ? "อนุมัติใหม่" : "อนุมัติการเผยแพร่"}
        </Button>
        {status.approval.valid && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            title="ถอนคำอนุมัติ — ฉบับที่เผยแพร่ไปแล้วจะยังอยู่"
            onClick={() => void run(() => revokeSnapshotApproval(tournament.id))}
          >
            ถอนคำอนุมัติ
          </Button>
        )}
        {(status.state === "PUBLISHED" || status.state === "PUBLISH_FAILED") && (
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            title="ลบไฟล์ที่เผยแพร่ออกจาก CDN — ข้อมูลในระบบยังอยู่ครบ"
            onClick={() => void run(() => retractSnapshot(tournament.id))}
          >
            <CloudOff size={14} />ถอนการเผยแพร่
          </Button>
        )}
        <Button
          size="sm"
          disabled={disabled || !status.approval.valid || blocked || !status.storageConfigured}
          title={status.approval.valid
            ? "สร้างและอัปโหลดฉบับเผยแพร่ตามข้อมูลที่ได้รับอนุมัติ"
            : "ต้องได้รับการอนุมัติก่อนจึงจะเผยแพร่ได้"}
          onClick={() => void run(() => publishSnapshot(tournament.id))}
        >
          <CloudUpload size={14} />{status.state === "PUBLISHED" ? "เผยแพร่ฉบับใหม่" : "เผยแพร่"}
        </Button>
      </div>
    </div>
  );
}

export { ACKNOWLEDGMENT_REV };
