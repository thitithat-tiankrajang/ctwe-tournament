"use client";

import { ArrowRight, Ban, CircleAlert, LoaderCircle, ShieldAlert } from "lucide-react";
import { useState } from "react";
import type { PairingValidation, Player } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";
import { useModalDialog } from "@/ui/overlay/use-modal-dialog";

/**
 * The confirmation sheet: four sections, in this order.
 *
 *  1. Pairing changes   — before → after, per slot.
 *  2. Consequences      — byes created, slots voided, pool entries and exits.
 *  3. Warnings          — acknowledged individually; commit stays disabled until all are.
 *  4. Blocks            — non-dismissible.
 *
 * Every row comes from the server's dry run. Nothing here is computed client-side, so the preview
 * cannot drift from what the commit will actually do — which is the whole reason validate and commit
 * share one evaluation on the server.
 */

const CONSEQUENCE_LABELS: Record<string, string> = {
  BECOMES_BYE: "กลายเป็นคู่บาย (ไม่มีคู่แข่ง)",
  BECOMES_VOID: "ยกเลิกคู่ (เก็บหมายเลขโต๊ะไว้)",
  UNVOIDED: "นำคู่ที่ยกเลิกไว้กลับมาใช้",
  POOL_ADD: "เข้า Screening Pool",
  POOL_REMOVE: "ออกจาก Screening Pool",
  RESULT_REMOVED: "ลบผลที่บันทึกไว้แล้ว",
};

interface Props {
  validation: PairingValidation;
  players: Map<string, Player>;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (password: string, acknowledged: string[]) => void;
  /** Offered only when the change set collides with recorded results that CAN be unwound. */
  onForce?: (acknowledged: string[]) => void;
}

export function PairingDiffSheet({ validation, players, busy, onCancel, onConfirm, onForce }: Props) {
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [password, setPassword] = useState("");
  // Not dismissible while committing: this sheet sits over the tool, and Escape cancelling a write
  // in flight would leave the operator unsure whether it landed.
  const dialog = useModalDialog({ open: true, onDismiss: onCancel, dismissible: !busy });

  const blocked = validation.blocks.length > 0 || validation.drift.length > 0;
  const allAcknowledged = validation.warnings.every((warning) => acknowledged.has(warning.code));
  const canCommit = !blocked && allAcknowledged && password.length > 0 && !busy;

  // Loose null check on purpose: the API serializes with non_null inclusion, so an empty seat
  // arrives as an absent key (undefined), not an explicit null.
  const name = (code: string | null | undefined) => {
    if (code == null) return "— ว่าง —";
    const player = players.get(code);
    return player ? `${code} ${player.firstName} ${player.lastName}` : code;
  };

  const toggle = (code: string) =>
    setAcknowledged((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={dialog.onBackdropMouseDown}>
      <section
        ref={dialog.ref as React.RefObject<HTMLElement>}
        tabIndex={-1}
        className="confirm-dialog diff-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialog.titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={dialog.titleId}>ตรวจสอบก่อนบันทึก</h2>

        <section className="diff-sheet__section">
          <h3>การเปลี่ยนแปลงคู่</h3>
          {validation.changes.length === 0 && <p className="page-description">ไม่มีคู่ที่เปลี่ยน</p>}
          <ul className="diff-sheet__list">
            {validation.changes.map((change) => (
              <li key={`${change.game}-${change.table}`}>
                <span className="diff-sheet__slot">เกม {change.game} โต๊ะ {change.table}</span>
                <span className="diff-sheet__before">{name(change.beforeOne)} พบ {name(change.beforeTwo)}</span>
                <ArrowRight size={13} aria-label="เปลี่ยนเป็น" />
                <span className="diff-sheet__after">{name(change.afterOne)} พบ {name(change.afterTwo)}</span>
              </li>
            ))}
          </ul>
        </section>

        {validation.consequences.length > 0 && (
          <section className="diff-sheet__section">
            <h3>ผลที่ตามมา</h3>
            <ul className="diff-sheet__list diff-sheet__list--plain">
              {validation.consequences.map((consequence, index) => (
                <li key={index}>
                  {CONSEQUENCE_LABELS[consequence.kind] ?? consequence.kind}
                  {consequence.table != null && ` · เกม ${consequence.game} โต๊ะ ${consequence.table}`}
                  {consequence.player && ` · ${name(consequence.player)}`}
                </li>
              ))}
            </ul>
          </section>
        )}

        {validation.warnings.length > 0 && (
          <section className="diff-sheet__section diff-sheet__section--warn">
            <h3><CircleAlert size={14} /> คำเตือน — ต้องยืนยันทีละข้อ</h3>
            {validation.warnings.map((warning) => (
              <label key={`${warning.code}-${warning.table}`} className="diff-sheet__ack">
                <input
                  type="checkbox"
                  checked={acknowledged.has(warning.code)}
                  onChange={() => toggle(warning.code)}
                />
                <span>โต๊ะ {warning.table} · {warning.message}</span>
              </label>
            ))}
          </section>
        )}

        {validation.drift.length > 0 && (
          <section className="diff-sheet__section diff-sheet__section--block">
            <h3><ShieldAlert size={14} /> มีผู้ใช้อื่นแก้ไขคู่เหล่านี้ไปแล้ว</h3>
            <ul className="diff-sheet__list diff-sheet__list--plain">
              {validation.drift.map((drift) => (
                <li key={`${drift.game}-${drift.table}`}>
                  เกม {drift.game} โต๊ะ {drift.table} — ตอนนี้เป็น {name(drift.actualOne)} พบ {name(drift.actualTwo)}
                </li>
              ))}
            </ul>
            <p className="page-description">ปิดหน้าต่างนี้แล้วเริ่มใหม่จากสถานะปัจจุบัน</p>
          </section>
        )}

        {validation.blocks.length > 0 && (
          <section className="diff-sheet__section diff-sheet__section--block">
            <h3><Ban size={14} /> ทำรายการนี้ไม่ได้</h3>
            <ul className="diff-sheet__list diff-sheet__list--plain">
              {validation.blocks.map((block, index) => <li key={index}>{block.message}</li>)}
            </ul>
            {validation.resultsToRemove.length > 0 && (
              validation.forceAvailable
                ? <p className="page-description">
                    คู่เหล่านี้กรอกผลไว้แล้ว หากจำเป็นต้องแก้จริง ๆ ต้องลบผลนั้นทิ้ง
                    ซึ่งเป็นการกระทำที่ย้อนกลับไม่ได้และต้องยืนยันอีกชั้นหนึ่ง
                  </p>
                : <p className="page-description">
                    ลบผลของคู่เหล่านี้ไม่ได้ เพราะมีผลอื่นที่คำนวณต่อจากผลนี้ไปแล้ว
                    ต้องจัดการผลปลายทางก่อน
                  </p>
            )}
          </section>
        )}

        {!blocked && (
          <FreshSecretInput
            placeholder="รหัสผ่านผู้อำนวยการเพื่อยืนยัน"
            value={password}
            aria-label="รหัสผ่านผู้อำนวยการเพื่อบันทึกการเปลี่ยนแปลงคู่"
            onChange={(event) => setPassword(event.target.value)}
          />
        )}

        <footer>
          <Button variant="secondary" onClick={onCancel}>กลับไปแก้ไข</Button>
          {/* Offered only when every colliding result can actually be unwound — never as a button
              that would fail after the operator has already committed to it. */}
          {blocked && onForce && validation.resultsToRemove.length > 0 && validation.forceAvailable && (
            <Button variant="danger" onClick={() => onForce([...acknowledged])} disabled={busy}>
              <ShieldAlert size={14} />
              ลบผล {validation.resultsToRemove.length} คู่ แล้วบันทึก…
            </Button>
          )}
          {!blocked && (
            <Button onClick={() => onConfirm(password, [...acknowledged])} disabled={!canCommit}>
              {busy ? <LoaderCircle className="loading-spinner" size={14} /> : null}
              บันทึกการเปลี่ยนแปลง
            </Button>
          )}
        </footer>
      </section>
    </div>
  );
}
