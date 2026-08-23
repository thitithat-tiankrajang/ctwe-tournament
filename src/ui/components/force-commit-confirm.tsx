"use client";

import { LoaderCircle, ShieldAlert } from "lucide-react";
import { useState } from "react";
import type { DestroyedResult, Player } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";
import { useModalDialog } from "@/ui/overlay/use-modal-dialog";

/**
 * The last thing between a director and a destroyed competition result.
 *
 * A password proves identity, not intent — so this lists every result that is about to be erased, in
 * full, and asks for the word ลบ to be typed. The operator has to read what they are erasing; there
 * is no way to hold the button down and get through it.
 *
 * Every row here comes from the server's dry run, and `forceAvailable` has already excluded anything
 * that cannot be safely unwound, so this screen never offers a removal the transaction would refuse.
 */

const CONFIRM_WORD = "ลบ";

interface Props {
  results: DestroyedResult[];
  players: Map<string, Player>;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (password: string) => void;
}

export function ForceCommitConfirm({ results, players, busy, onCancel, onConfirm }: Props) {
  const [password, setPassword] = useState("");
  const [typed, setTyped] = useState("");
  const dialog = useModalDialog({ open: true, onDismiss: onCancel, dismissible: !busy });

  const ready = password.length > 0 && typed.trim() === CONFIRM_WORD && !busy;
  const name = (code: string | null) => {
    if (code == null) return "— ว่าง —";
    const player = players.get(code);
    return player ? `${code} ${player.firstName} ${player.lastName}` : code;
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={dialog.onBackdropMouseDown}>
      <section
        ref={dialog.ref as React.RefObject<HTMLElement>}
        tabIndex={-1}
        className="confirm-dialog confirm-dialog--danger force-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialog.titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div className="confirm-dialog__icon"><ShieldAlert size={20} /></div>
          <div>
            <span>ลบผลการแข่งขันถาวร</span>
            <h2 id={dialog.titleId}>จะลบผลที่บันทึกไว้แล้ว {results.length} คู่</h2>
          </div>
        </header>

        <p>
          ผลด้านล่างจะถูกลบออกจากการแข่งขัน และอันดับจะถูกคำนวณใหม่
          ผลที่ผู้ชมเห็นแล้วจะถูกแสดงเป็น &ldquo;ถอนผล&rdquo; จนกว่าจะมีการกรอกผลใหม่
          บันทึกการตรวจสอบ (audit) จะเก็บผลเดิมไว้ถาวร
        </p>

        <ul className="force-confirm__list">
          {results.map((doomed) => (
            <li key={`${doomed.game}-${doomed.table}`}>
              <span className="force-confirm__slot">เกม {doomed.game} · โต๊ะ {doomed.table}</span>
              <span className="force-confirm__players">
                {name(doomed.playerOne)} {doomed.scoreOne ?? "—"} : {doomed.scoreTwo ?? "—"} {name(doomed.playerTwo)}
              </span>
              <span className="force-confirm__meta">
                {doomed.winner ? `ผู้ชนะ ${doomed.winner}` : doomed.resultType === "DRAW" ? "เสมอ" : "ไม่มีผู้ชนะ"}
                {doomed.submittedBy && ` · บันทึกโดย ${doomed.submittedBy}`}
                {doomed.submittedAt && ` · ${new Date(doomed.submittedAt).toLocaleString("th-TH")}`}
              </span>
            </li>
          ))}
        </ul>

        <label className="form-label" htmlFor="force-confirm-word">
          พิมพ์คำว่า &ldquo;{CONFIRM_WORD}&rdquo; เพื่อยืนยันว่าอ่านรายการข้างต้นแล้ว
        </label>
        <input
          id="force-confirm-word"
          className="input"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          aria-label={`พิมพ์คำว่า ${CONFIRM_WORD} เพื่อยืนยันการลบผล`}
        />

        <label className="form-label" htmlFor="force-confirm-password">รหัสผ่านผู้อำนวยการ</label>
        <FreshSecretInput
          id="force-confirm-password"
          placeholder="รหัสผ่านผู้อำนวยการ"
          value={password}
          aria-label="รหัสผ่านผู้อำนวยการเพื่อยืนยันการลบผล"
          onChange={(event) => setPassword(event.target.value)}
        />

        <footer>
          <Button variant="secondary" onClick={onCancel}>ยกเลิก</Button>
          <Button variant="danger" onClick={() => onConfirm(password)} disabled={!ready}>
            {busy ? <LoaderCircle className="loading-spinner" size={14} /> : <ShieldAlert size={14} />}
            ลบผลและบันทึกการเปลี่ยนแปลง
          </Button>
        </footer>
      </section>
    </div>
  );
}
