/**
 * The consent text shown before a public snapshot may be approved — architecture §4.4, verbatim.
 *
 * Publishing puts competitors' real names and school affiliations on a public CDN permanently, and
 * some of those competitors are minors. This text is what an approver is agreeing to, so it says the
 * uncomfortable parts plainly rather than softening them: retraction stops new access but cannot
 * recall copies, and closing the tournament link does not remove a published snapshot.
 *
 * `ACKNOWLEDGMENT_REV` is sent with the approval and stored on the record, so what was recorded as
 * consent can always be traced back to the exact wording that was displayed. The backend refuses any
 * other revision. **Bump this whenever the text below changes materially, and bump
 * `SnapshotApprovalService.ACKNOWLEDGMENT_REV` in the same commit** — the two are one contract.
 */
export const ACKNOWLEDGMENT_REV = 1;

export function SnapshotAcknowledgment() {
  return (
    <div className="console-note console-stack" role="note" aria-label="ข้อตกลงก่อนเผยแพร่">
      <strong>การเผยแพร่นี้ถาวรและเรียกคืนไม่ได้</strong>
      <p>
        ข้อมูลที่จะเผยแพร่ประกอบด้วย <strong>ชื่อ-นามสกุลจริง</strong> และ{" "}
        <strong>สังกัดโรงเรียน/สถาบัน</strong> ของผู้เข้าแข่งขัน ซึ่งบางส่วนอาจเป็นผู้เยาว์ เมื่อเผยแพร่แล้ว:
      </p>
      <ul>
        <li>ผู้ใช้ทั่วไปสามารถดาวน์โหลดและทำสำเนาได้</li>
        <li>เบราว์เซอร์และ CDN อาจเก็บสำเนาไว้</li>
        <li>บุคคลที่สามอาจคัดลอกหรือทำดัชนีข้อมูล</li>
        <li>
          <strong>การถอนการเผยแพร่ (retract) จะหยุดการเข้าถึงใหม่ แต่ไม่สามารถเรียกคืนสำเนาที่ถูกดาวน์โหลดไปแล้วได้</strong>
        </li>
        <li>การปิดลิงก์ (CLOSED) <strong>ไม่</strong> ทำให้ฉบับเผยแพร่หายไป — ต้องกดถอนการเผยแพร่เท่านั้น</li>
      </ul>
      <p className="muted">
        <em>
          This publication is permanent and cannot be recalled. Retraction stops new access but cannot
          retrieve copies already downloaded. Closing the tournament link does NOT remove a published
          snapshot.
        </em>
      </p>
    </div>
  );
}
