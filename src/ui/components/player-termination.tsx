"use client";

import { LockKeyhole, Search, Undo2, X, UserMinus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import type { TournamentCard } from "@/domain/tournament/types";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";


/**
 * Director-only terminate / restore of players in a running card (per card, password-confirmed).
 * Terminated players leave future pairings and standings; restoring charges each missed game as a
 * loss of the entered points. When the current pairing already exists, the restore dialog explains
 * the placement (case A/B/C) exactly as the backend will apply it.
 */
export function PlayerTermination({ card }: { card: TournamentCard }) {
  const terminatePlayers = useTournamentStore((state) => state.terminatePlayers);
  const restorePlayers = useTournamentStore((state) => state.restorePlayers);

  const active = useMemo(() => card.players.filter((p) => !p.terminated), [card.players]);
  const terminated = useMemo(() => card.players.filter((p) => p.terminated), [card.players]);

  const [mode, setMode] = useState<"terminate" | "restore" | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [password, setPassword] = useState("");
  const [lossPoints, setLossPoints] = useState("100");
  const [unpair, setUnpair] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState(false);
  const [tab, setTab] = useState<"list" | "picked">("list");

  // Case detection mirrors the backend so the dialog explains what will actually happen.
  const preview = card.snapshots.find((s) => !s.confirmedAt);
  const pairingExists = card.runtimeStage === "PAIRING_PREVIEW" || card.runtimeStage === "RESULT_COLLECTION";
  const anyResultInBlock = Boolean(preview?.pairings.some((p) => Boolean(p.resultType)));
  const restoreCase: "A" | "B" | "C" = !pairingExists ? "A" : !anyResultInBlock ? "B" : "C";

  const pendingPlayers = new Set(preview?.pairings.filter((pair) => !pair.resultType)
    .flatMap((pair) => [pair.playerOneId,pair.playerTwoId]) ?? []);
  const canPick = (id: string) => mode !== "terminate" || !pendingPlayers.has(id);
  const candidates = mode === "terminate" ? active : terminated;
  // Current-game pair of each player, shown on the row and searchable as "คู่ N".
  const pairOf = useMemo(() => {
    const map = new Map<string, number>();
    for (const snapshot of card.snapshots) for (const pair of snapshot.pairings) {
      if ((pair.gameNumber ?? snapshot.gameNumbers[0]) !== card.currentGame) continue;
      for (const id of [pair.playerOneId, pair.playerTwoId]) if (id) map.set(id, pair.tableNumber);
    }
    return map;
  }, [card.snapshots, card.currentGame]);
  const [eligibleOnly, setEligibleOnly] = useState(false);
  const matches = candidates.filter((player) => {
    if (eligibleOnly && !canPick(player.id)) return false;
    const term = query.trim();
    const pairQuery = /^คู่(?:ที่)?\s*(\d+)$/.exec(term);
    if (pairQuery) return pairOf.get(player.id) === Number(pairQuery[1]);
    if (/^[A-Za-z]*\d+$/.test(term)) {
      const amount = Number(term.replace(/^[A-Za-z]+/,""));
      const prefix = term.match(/^[A-Za-z]+/)?.[0].toUpperCase();
      return Number(player.id.replace(/^[A-Za-z]+/,"")) === amount && (!prefix || player.id.startsWith(prefix));
    }
    return `${player.id} ${player.firstName} ${player.lastName} ${player.school}`.toLowerCase().includes(term.toLowerCase());
  });
  const open = (next: "terminate" | "restore") => {
    setQuery(""); setReview(false); setTab("list");
    setMode(next); setSelected(new Set()); setPassword(""); setLossPoints("100"); setUnpair(false); setError("");
  };
  const close = () => {
    if (busy) return;
    setPassword("");
    setReview(false);
    setMode(null);
  };
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const submit = async () => {
    const ids = [...selected];
    if (ids.length === 0) { setError("เลือกผู้เล่นอย่างน้อย 1 คน"); return; }
    if (!password) { setError("กรอกรหัสผ่านผู้อำนวยการ"); return; }
    setBusy(true); setError("");
    try {
      if (mode === "terminate") {
        await terminatePlayers(card.id, ids, password);
      } else {
        const points = Number(lossPoints);
        if (!Number.isInteger(points) || points < 0) { setError("แต้มปรับแพ้ต้องเป็นจำนวนเต็ม ≥ 0"); setBusy(false); return; }
        await restorePlayers(card.id, ids, password, points, restoreCase === "B" && unpair);
      }
      setPassword("");
      setReview(false);
      setMode(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "ทำรายการไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const title = mode === "terminate" ? "ถอนผู้เล่น" : "ดึงผู้เล่นกลับ";
  const chosen = candidates.filter((player) => selected.has(player.id));
  const startReview = () => {
    if (!chosen.length) { setError("เลือกผู้เล่นอย่างน้อย 1 คน"); return; }
    if (mode === "restore" && (!lossPoints.trim() || !Number.isInteger(Number(lossPoints)) || Number(lossPoints) < 0)) {
      setError("แต้มปรับแพ้ต้องเป็นจำนวนเต็มตั้งแต่ 0"); return;
    }
    if (chosen.some((player) => !canPick(player.id))) { setError("ผู้เล่นที่เลือกมีคู่ที่ยังรอผล"); return; }
    setError("");
    setReview(true);
  };

  return <>
    <button type="button" className="btn btn--danger" disabled={!active.length} onClick={() => open("terminate")}>
      <UserMinus className="i" size={15} />ถอนผู้เล่น<LockKeyhole className="i" size={12} /></button>
    <button type="button" className="btn btn--restore" disabled={!terminated.length} onClick={() => open("restore")}>
      <Undo2 className="i" size={15} />ดึงผู้เล่นกลับ<LockKeyhole className="i" size={12} /></button>

    <ConfirmDialog appearance="prototype" open={mode !== null && !review} title={title} eyebrow=""
      confirmLabel="ตรวจรายการ" confirmDisabled={chosen.length === 0} danger={mode === "terminate"} error={error || undefined}
      className="dialog--roster-tool dialog--roster-pick" onConfirm={startReview} onCancel={close}>
      {mode === "terminate" && <p className="roster-effect">ผู้เล่นที่เลือกจะไม่ถูกจับคู่ในรอบถัดไป ประวัติการแข่งขันยังอยู่</p>}
      <div className="roster-tool-tabs" role="group" aria-label="มุมมองรายชื่อ">
        <button type="button" aria-pressed={tab === "list"} onClick={() => setTab("list")}>รายชื่อ</button>
        <button type="button" aria-pressed={tab === "picked"} onClick={() => setTab("picked")}>ที่เลือก ({chosen.length})</button>
      </div>
      <div className="roster-picker" data-tab={tab}>
        <section className="roster-pick-list">
          <div className="roster-pick-filters"><div className="roster-search"><Search className="i" size={16} />
            <input className="input" type="search" aria-label="ค้นหาผู้เล่น" placeholder="รหัส ชื่อ โรงเรียน หรือเลขคู่" autoComplete="off" value={query}
              onChange={(event) => setQuery(event.target.value)} /></div>
            {mode === "terminate" && <label className="roster-available"><input type="checkbox" checked={eligibleOnly}
              onChange={(event) => setEligibleOnly(event.target.checked)} /> เฉพาะที่เลือกได้</label>}</div>
          <header className="roster-pick-header"><span role="status">พบ {matches.length} คน</span>
            <button type="button" className="btn btn--sm btn--ghost" disabled={!matches.some((player) => canPick(player.id))}
              onClick={() => setSelected((previous) => new Set([...previous,...matches.filter((player) => canPick(player.id)).map((player) => player.id)]))}>เลือกผลค้นหาทั้งหมด</button>
          </header>
          <div className="roster-picker-scroll">
            {matches.map((player) => <label key={player.id} className={`roster-pick-row${canPick(player.id) ? "" : " is-blocked"}`}>
              <input type="checkbox" checked={selected.has(player.id)} disabled={!canPick(player.id)} onChange={() => toggle(player.id)} />
              <span className="code">{player.id}</span><span className="roster-pick-person"><strong>{player.firstName} {player.lastName}</strong><small>{player.school}</small></span>
              {!canPick(player.id) ? <small className="roster-pick-status">รอผลคู่ {pairOf.get(player.id) ?? ""}</small>
                : pairOf.has(player.id) && <small className="roster-pick-status roster-pick-pair">คู่ {pairOf.get(player.id)}</small>}
            </label>)}
            {!matches.length && <p className="roster-picker-empty">ไม่พบผู้เล่นตามเงื่อนไข</p>}
          </div>
        </section>
        <section className="roster-pick-selected">
          <header className="roster-pick-header"><strong>เลือกแล้ว {chosen.length} คน</strong>
            <button type="button" className="btn btn--sm btn--ghost" disabled={!chosen.length} onClick={() => setSelected(new Set())}>ล้าง</button></header>
          <div className="roster-picker-scroll">{chosen.map((player) => <div className="roster-picked-row" key={player.id}>
            <b className="code">{player.id}</b><span>{player.firstName} {player.lastName}</span>
            <button type="button" className="roster-remove" aria-label={`เอา ${player.id} ออกจากรายการ`} onClick={() => toggle(player.id)}><X className="i" size={15} /></button>
          </div>)}
          {!chosen.length && <div className="roster-picked-empty"><span><Users className="i" size={18} /></span>
            <strong>ยังไม่ได้เลือกผู้เล่น</strong><small>เลือกจากรายชื่อเพื่อเพิ่มมาที่นี่</small></div>}</div>
        </section>
      </div>
      {mode === "restore" && <div className="roster-tool-options">
        {restoreCase === "A" && <p className="meta">ผู้เล่นจะกลับเข้าเกม {card.currentGame} และถูกปรับแพ้ในเกมที่ขาด</p>}
        {restoreCase === "B" && <fieldset className="dir-filter-status"><legend>คู่เกม {card.currentGame} ถูกสร้างแล้ว</legend>
          <label className="dir-filter-option"><input type="radio" name="unpair" checked={unpair} onChange={() => setUnpair(true)} />ยกเลิกการจับคู่เพื่อนำผู้เล่นเข้าเกมนี้</label>
          <label className="dir-filter-option"><input type="radio" name="unpair" checked={!unpair} onChange={() => setUnpair(false)} />คงคู่เดิมและกลับเข้าเกมถัดไป</label>
        </fieldset>}
        {restoreCase === "C" && <p className="meta">เกม {card.currentGame} มีผลแล้ว ผู้เล่นจะถูกปรับแพ้เกมนี้และกลับในเกมถัดไป</p>}
        <div className="field"><label htmlFor="loss-points">ผลต่างที่หักต่อเกมที่ขาด</label><input className="input"
          id="loss-points" type="number" min={0} value={lossPoints} onChange={(event) => setLossPoints(event.target.value)} /></div>
      </div>}
    </ConfirmDialog>

    <ConfirmDialog appearance="prototype" open={mode !== null && review} title={`${title}ที่เลือก?`} eyebrow="ยืนยันการเปลี่ยนแปลง"
      confirmLabel={`ยืนยัน${title}`} cancelLabel="กลับไปแก้ไข" danger={mode === "terminate"} busy={busy} error={error || undefined}
      className="dialog--roster-tool dialog--roster-review" onConfirm={() => void submit()}
      onCancel={() => { setReview(false); setPassword(""); setError(""); }}>
      <div className="msw-summary"><p className="msw-summary-count"><strong>{title} {chosen.length} คน</strong></p>
        <div className="msw-summary-scroll"><table className="dt screen-summary" aria-label="ผู้เล่นที่ยืนยันการเปลี่ยนแปลง"><thead><tr><th scope="col">รหัส</th><th scope="col">ผู้เล่น</th><th scope="col">โรงเรียน</th></tr></thead>
          <tbody>{chosen.map((player) => <tr key={player.id}><td className="code">{player.id}</td>
            <td>{player.firstName} {player.lastName}</td><td>{player.school}</td></tr>)}</tbody></table></div>
        {mode === "restore" && <dl className="msw-summary-pool"><div><dt>ผลต่างที่หักต่อเกมที่ขาด</dt><dd>{Number(lossPoints).toLocaleString("th-TH")} คะแนน</dd></div></dl>}
      </div>
      <div className="field"><label htmlFor="term-password">รหัสผ่านผู้อำนวยการ</label>
        <FreshSecretInput className="input" id="term-password" value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} />
      </div>
    </ConfirmDialog>
  </>;
}
