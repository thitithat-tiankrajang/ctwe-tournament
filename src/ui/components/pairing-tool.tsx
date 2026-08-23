"use client";

import { AlertTriangle, LoaderCircle, UserMinus, UserPlus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { isBadPassword, useTournamentStore } from "@/application/tournament/store";
import type {
  PairingChangeSet,
  PairingValidation,
  Player,
  ScreeningHold,
  ScreeningReason,
  SlotState,
  TournamentCard,
} from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";
import { useModalDialog } from "@/ui/overlay/use-modal-dialog";
import { PairingDiffSheet } from "@/ui/components/pairing-diff-sheet";

/**
 * The Screening Pool and Multi Switching are one tool. This is its Screening Mode entry point:
 * the left panel lists the live pairing with bulk select, the right panel is the pool.
 *
 * <p>Staging is client-only and never persisted. The server holds the one source of truth for
 * pairings; a server-side draft would be a second one. The costs are bounded and accepted — a
 * refresh loses staging (nothing committed, nothing corrupted), and two directors staging the same
 * slots are caught by the per-slot precondition at commit.
 */

const REASONS: { value: ScreeningReason; label: string }[] = [
  { value: "NO_SHOW", label: "ไม่มาแข่ง" },
  { value: "LATE", label: "มาสาย" },
  { value: "MEDICAL", label: "เหตุสุขภาพ" },
  { value: "OTHER", label: "อื่น ๆ" },
];

/** Below this the tool does not render at all. A cramped version of an operation that can destroy
 *  competition results is worse than no version. */
const MIN_WIDTH = 1024;

interface SlotRow {
  game: number;
  table: number;
  one: string | null;
  two: string | null;
  hasResult: boolean;
  voided: boolean;
}

interface Props {
  card: TournamentCard;
  open: boolean;
  onClose: () => void;
}

export function PairingTool({ card, open, onClose }: Props) {
  const validatePairingChange = useTournamentStore((state) => state.validatePairingChange);
  const commitPairingChange = useTournamentStore((state) => state.commitPairingChange);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState<ScreeningReason>("NO_SHOW");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<PairingValidation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [wideEnough, setWideEnough] = useState(true);

  // dismissible is false while a commit is in flight: Escape and the backdrop must not cancel a
  // running write. The title id comes from the hook rather than a literal, because this tool and
  // its diff sheet are open at the same time and a shared hard-coded id mislabels one of them.
  const dialog = useModalDialog({ open, onDismiss: onClose, dismissible: !busy });

  useEffect(() => {
    const check = () => setWideEnough(window.innerWidth >= MIN_WIDTH);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Reset staging whenever the tool is reopened: staging is per-session by design, and carrying it
  // across an open would let an operator commit a change set built against a board they last saw
  // ten minutes ago.
  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setPreview(null);
      setError("");
      setNote("");
    }
  }, [open]);

  const players = useMemo(
    () => new Map(card.players.map((player) => [player.id, player])),
    [card.players],
  );
  const pool = card.screeningPool ?? [];
  const heldIds = useMemo(() => new Set(pool.map((hold) => hold.player)), [pool]);
  const slots = useMemo(() => liveSlots(card), [card]);

  if (!open) return null;

  if (!wideEnough) {
    return (
      <div className="dialog-backdrop" role="presentation" onMouseDown={dialog.onBackdropMouseDown}>
        <section
          ref={dialog.ref as React.RefObject<HTMLElement>}
          tabIndex={-1}
          className="confirm-dialog pairing-tool pairing-tool--narrow"
          role="dialog"
          aria-modal="true"
          aria-labelledby={dialog.titleId}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <h2 id={dialog.titleId}>ต้องใช้จอที่กว้างกว่านี้</h2>
          <p className="page-description">
            เครื่องมือจัดคู่และ Screening Pool ใช้ได้บนเดสก์ท็อปและแท็บเล็ตเท่านั้น
            การย่อหน้าจอที่กดพลาดได้ง่ายไม่เหมาะกับงานที่แก้คู่การแข่งขันจริง
          </p>
          <footer>
            <Button variant="secondary" onClick={onClose}>ปิด</Button>
          </footer>
        </section>
      </div>
    );
  }

  const changeSet = (): PairingChangeSet => {
    const targets = slots.filter((slot) => occupants(slot).some((code) => selected.has(code ?? "")));
    return {
      expect: targets.map(toSlotState),
      slots: [],
      screen: [...selected].map((player) => ({ player, reason, note: note.trim() || undefined })),
      release: [],
      confirmWarnings: [],
    };
  };

  const review = async () => {
    setBusy(true);
    setError("");
    try {
      setPreview(await validatePairingChange(card.id, changeSet()));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "ตรวจสอบไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const commit = async (password: string, acknowledged: string[]) => {
    setBusy(true);
    setError("");
    try {
      // One key per attempt, reused across retries: a commit that times out on the venue network can
      // be pressed again without applying twice.
      await commitPairingChange(card.id, { ...changeSet(), confirmWarnings: acknowledged },
        password, crypto.randomUUID());
      onClose();
    } catch (failure) {
      setError(isBadPassword(failure) ? "รหัสผ่านไม่ถูกต้อง"
        : failure instanceof Error ? failure.message : "บันทึกไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (code: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={dialog.onBackdropMouseDown}>
      <section
        ref={dialog.ref as React.RefObject<HTMLElement>}
        tabIndex={-1}
        className="confirm-dialog pairing-tool"
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialog.titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="pairing-tool__eyebrow">Screening Mode</span>
            <h2 id={dialog.titleId}>พักผู้เล่นออกจากคู่ชั่วคราว · เกม {card.currentGame}</h2>
          </div>
          <button type="button" className="confirm-dialog__close" onClick={onClose} aria-label="ปิด"><X size={18} /></button>
        </header>

        <div className="pairing-tool__cols">
          <section className="pairing-tool__col" aria-label="คู่แข่งขันปัจจุบัน">
            <p className="pairing-tool__h">
              คู่แข่งขันปัจจุบัน · เลือกผู้เล่นที่ยังไม่มา ({selected.size} คน)
            </p>
            <ul className="pairing-tool__slots">
              {slots.map((slot) => (
                <li key={`${slot.game}-${slot.table}`} className={slotClass(slot)}>
                  <span className="pairing-tool__no">โต๊ะ {slot.table}</span>
                  <span className="pairing-tool__pair">
                    <Seat code={slot.one} players={players} slot={slot} selected={selected} onToggle={toggle} />
                    <span className="pairing-tool__vs">พบ</span>
                    <Seat code={slot.two} players={players} slot={slot} selected={selected} onToggle={toggle} />
                  </span>
                  {slot.hasResult && <span className="pairing-tool__tag">กรอกผลแล้ว</span>}
                  {slot.voided && <span className="pairing-tool__tag">ยกเลิกคู่</span>}
                </li>
              ))}
            </ul>
          </section>

          <section className="pairing-tool__col" aria-label="Screening Pool">
            <p className="pairing-tool__h">Screening Pool · {pool.length} คน</p>
            {pool.length === 0 && (
              <p className="page-description">ยังไม่มีผู้เล่นถูกพักไว้</p>
            )}
            {pool.map((hold) => (
              <PoolCard key={hold.player} hold={hold} players={players} />
            ))}

            <p className="pairing-tool__h">เหตุผลที่พัก</p>
            <div className="pairing-tool__reasons">
              {REASONS.map((option) => (
                <label key={option.value} className="pairing-tool__reason">
                  <input
                    type="radio"
                    name="screening-reason"
                    value={option.value}
                    checked={reason === option.value}
                    onChange={() => setReason(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
            <input
              className="input"
              placeholder="บันทึกเพิ่มเติม (ไม่บังคับ)"
              value={note}
              maxLength={280}
              onChange={(event) => setNote(event.target.value)}
              aria-label="บันทึกเพิ่มเติมเกี่ยวกับการพักผู้เล่น"
            />
          </section>
        </div>

        {error && <p className="confirm-dialog__error" role="alert">{error}</p>}

        <footer>
          <span className="pairing-tool__hint">
            {heldIds.size > 0 && "ต้องจัดการผู้เล่นใน Screening Pool ให้ครบก่อนจึงจะ Review เกมนี้ได้"}
          </span>
          <Button variant="secondary" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={() => void review()} disabled={busy || selected.size === 0}>
            {busy ? <LoaderCircle className="loading-spinner" size={14} /> : <UserMinus size={14} />}
            ตรวจสอบผลกระทบ
          </Button>
        </footer>

        {preview && (
          <PairingDiffSheet
            validation={preview}
            players={players}
            busy={busy}
            onCancel={() => setPreview(null)}
            onConfirm={commit}
          />
        )}
      </section>
    </div>
  );
}

function Seat({
  code, players, slot, selected, onToggle,
}: {
  code: string | null;
  players: Map<string, Player>;
  slot: SlotRow;
  selected: Set<string>;
  onToggle: (code: string) => void;
}) {
  if (code === null) return <span className="pairing-tool__empty">— ว่าง —</span>;
  const player = players.get(code);
  const locked = slot.hasResult;
  return (
    <label className={`pairing-tool__seat${selected.has(code) ? " is-selected" : ""}${locked ? " is-locked" : ""}`}>
      <input
        type="checkbox"
        checked={selected.has(code)}
        disabled={locked}
        onChange={() => onToggle(code)}
        aria-label={`พัก ${code} ${player ? `${player.firstName} ${player.lastName}` : ""}`}
      />
      <span className="pairing-tool__code">{code}</span>
      {player && <span className="pairing-tool__name">{player.firstName} {player.lastName}</span>}
    </label>
  );
}

function PoolCard({ hold, players }: { hold: ScreeningHold; players: Map<string, Player> }) {
  const player = players.get(hold.player);
  const label = REASONS.find((option) => option.value === hold.reason)?.label ?? hold.reason;
  return (
    <div className="pairing-tool__hold">
      <div className="pairing-tool__hold-top">
        <span className="pairing-tool__code">{hold.player}</span>
        {player && <span className="pairing-tool__name">{player.firstName} {player.lastName}</span>}
        <span className="pairing-tool__reason-tag">{label}</span>
      </div>
      <p className="pairing-tool__hold-ctx">
        {new Date(hold.screenedAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })}
        {hold.originTable !== null && (
          hold.originStale
            ? " · คู่เดิมถูกแก้ไขไปแล้ว"
            : ` · เดิมโต๊ะ ${hold.originTable}${hold.originOpponent ? ` พบ ${hold.originOpponent}` : ""}`
        )}
      </p>
      {hold.note && <p className="pairing-tool__hold-ctx">{hold.note}</p>}
    </div>
  );
}

/** Slots of the live, unpublished pairing — the only thing this tool may touch. */
function liveSlots(card: TournamentCard): SlotRow[] {
  const open = card.snapshots.filter((snapshot) => !snapshot.confirmedAt);
  const rows: SlotRow[] = [];
  for (const snapshot of open)
    for (const pairing of snapshot.pairings)
      rows.push({
        game: pairing.gameNumber ?? card.currentGame,
        table: pairing.tableNumber,
        // The API serializes with non_null inclusion, so an empty seat arrives as an ABSENT key
        // rather than an explicit null. Normalise here: everything downstream compares to null, and
        // `undefined === null` is false — which would render an empty seat as an occupied one.
        one: pairing.playerOneId ?? null,
        two: pairing.playerTwoId ?? null,
        hasResult: pairing.resultType != null,
        voided: pairing.voided === true,
      });
  return rows.sort((a, b) => a.game - b.game || a.table - b.table);
}

const occupants = (slot: SlotRow) => [slot.one, slot.two];

const toSlotState = (slot: SlotRow): SlotState => ({
  game: slot.game, table: slot.table, one: slot.one, two: slot.two,
});

function slotClass(slot: SlotRow): string {
  if (slot.voided) return "pairing-tool__slot is-void";
  if (slot.hasResult) return "pairing-tool__slot is-locked";
  if (slot.one === null || slot.two === null) return "pairing-tool__slot is-empty";
  return "pairing-tool__slot";
}

/**
 * The warning shown before generating a pairing while anyone is held.
 *
 * Held players are excluded from the generated field, and re-seating them afterwards requires
 * regenerating — which stops being possible the moment any result is entered. Saying so here turns a
 * dead end discovered at the worst moment into a choice made at a calm one.
 */
export function ScreeningGenerationWarning({ pool }: { pool: ScreeningHold[] }) {
  if (pool.length === 0) return null;
  return (
    <div className="screening-warning" role="status">
      <AlertTriangle size={15} />
      <div>
        <strong>มีผู้เล่นถูกพักไว้ {pool.length} คน ({pool.map((hold) => hold.player).join(", ")})</strong>
        <p>
          ผู้เล่นเหล่านี้จะไม่อยู่ในคู่ที่กำลังจะสร้าง หากต้องการให้กลับเข้าคู่ในเกมนี้
          ต้องยกเลิกการจับคู่แล้วสุ่มใหม่ — และเมื่อกรอกผลคู่ใดคู่หนึ่งแล้วจะทำไม่ได้อีก
        </p>
      </div>
    </div>
  );
}

/** Entry-point button for the tables page. */
export function ScreeningModeButton({ card }: { card: TournamentCard }) {
  const openPairingSession = useTournamentStore((state) => state.openPairingSession);
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pool = card.screeningPool ?? [];

  const authenticate = async () => {
    setBusy(true);
    setError("");
    try {
      await openPairingSession(card.id, password);
      setPassword("");
      setAsking(false);
      setOpen(true);
    } catch (failure) {
      setError(isBadPassword(failure) ? "รหัสผ่านไม่ถูกต้อง" : "เปิดเครื่องมือไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="secondary" onClick={() => setAsking(true)}>
        <UserPlus size={14} />
        Screening Pool{pool.length > 0 ? ` (${pool.length})` : ""}
      </Button>

      <ConfirmDialog
        open={asking}
        title="ยืนยันรหัสผ่านผู้อำนวยการ"
        description="การพักผู้เล่นและการแก้คู่เป็นสิทธิ์ของผู้อำนวยการ ระบบจะขอรหัสผ่านอีกครั้งตอนบันทึก"
        eyebrow="Screening Pool"
        icon={<UserPlus size={20} />}
        confirmLabel="เปิดเครื่องมือ"
        busy={busy}
        busyLabel="กำลังตรวจสอบ…"
        error={error}
        onConfirm={() => void authenticate()}
        onCancel={() => { setAsking(false); setPassword(""); setError(""); }}
      >
        <label className="form-label" htmlFor="screening-password">รหัสผ่านผู้อำนวยการ</label>
        <FreshSecretInput
          id="screening-password"
          placeholder="รหัสผ่านผู้อำนวยการ"
          value={password}
          aria-label="รหัสผ่านผู้อำนวยการเพื่อเปิดเครื่องมือจัดคู่"
          onChange={(event) => setPassword(event.target.value)}
        />
      </ConfirmDialog>

      <PairingTool card={card} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
