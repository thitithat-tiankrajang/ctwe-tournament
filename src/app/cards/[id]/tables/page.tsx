"use client";

import "../../../prototype-results.css";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowRight, LoaderCircle, LockKeyhole, Shuffle, Sparkles, Undo2 } from "lucide-react";
import { useState } from "react";
import { isBadPassword, selectCard, useTournamentStore } from "@/application/tournament/store";
import { appDialog } from "@/application/ui/dialog";
import { canManageTournament } from "@/domain/tournament/roles";
import type { Pairing, Player } from "@/domain/tournament/types";
import { rankingAfterGame } from "@/domain/tournament/history";
import { clearPairingDraft } from "@/ui/components/pairing-ui-draft";
import { SelectMenu } from "@/ui/components/select-menu";
import { isVoidPairing } from "@/domain/tournament/pairing-slot";
import { Button } from "@/ui/components/button";
import { useNavigateWithPending } from "@/ui/layout/use-navigate-with-pending";
import { CardNotFound } from "@/ui/components/card-not-found";
import { pairingRuleForGame } from "@/ui/components/game-flow";
import { DirectPlayerSwap } from "@/ui/components/direct-player-swap";
import { EmptyState } from "@/ui/components/page";
import { editableResultGames } from "@/domain/tournament/flow";
import { matchesPlayerCode } from "@/domain/tournament/player-code";
import { useWorkspaceListFilter, WorkspaceListFilter, WorkspaceListToolbar } from "@/ui/components/workspace-list-filter";
import { PairingToolButtons, canOpenScreening } from "@/ui/components/pairing-tool";

export default function TablesPage() {
  const { id } = useParams<{ id: string }>();
  const { pending: navPending, navigate } = useNavigateWithPending();
  const cards = useTournamentStore((state) => state.cards);
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const generatePairings = useTournamentStore((state) => state.generatePairings);
  const confirmPairing = useTournamentStore((state) => state.confirmPairingPreview);
  const swapPlayers = useTournamentStore((state) => state.swapPlayers);
  const undoPairing = useTournamentStore((state) => state.undoPairing);
  const card = selectCard(cards, id);
  const [busy, setBusy] = useState(false);
  const [browseGame, setBrowseGame] = useState<{ round: number; game: number } | null>(null);
  const filter = useWorkspaceListFilter();

  if (loading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;
  // Pairing/tables is the director's work. Result-entry staff enter results on the games page;
  // admins and public viewers only watch the overview.
  if (!canManageTournament(auth)) return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับผู้อำนวยการเท่านั้น" description="การจับคู่และโต๊ะแข่งขันเป็นงานของผู้อำนวยการ เจ้าหน้าที่กรอกผลทำงานที่หน้าผลการแข่งขัน" action={<Link prefetch={false} href={`/cards/${id}`}><Button>กลับหน้าภาพรวม</Button></Link>} /></div>;
  if (!card) return <CardNotFound />;

  const players = new Map(card.players.map((player) => [player.id, player]));
  const canGenerate = card.runtimeStage === "TABLE_PAIRING";
  const preview = card.runtimeStage === "PAIRING_PREVIEW";
  const manualGameOne = preview && card.currentGame === 1;
  const currentSnapshot = card.snapshots.find((snapshot) => !snapshot.confirmedAt && snapshot.gameNumbers.includes(card.currentGame));
  const currentPairings = currentSnapshot?.pairings.filter((pairing) => pairing.gameNumber === card.currentGame) ?? [];
  const gameOnePairs: Pairing[] = manualGameOne
    ? card.tables
        .flatMap((table) => {
          const pairs: { one: string; two: string | null }[] = [];
          for (let i = 0; i < table.playerIds.length; i += 2)
            pairs.push({ one: table.playerIds[i], two: table.playerIds[i + 1] ?? null });
          return pairs;
        })
        .map((pair, index) => ({ id: `g1-${index + 1}`, gameNumber: 1, tableNumber: index + 1, playerOneId: pair.one, playerTwoId: pair.two }))
    : [];
  const previewPairings = currentPairings.length || !manualGameOne ? currentPairings : gameOnePairs;
  const gibsonPairings = previewPairings.filter((pairing) =>
    pairing.playerOneGibsonized || pairing.playerTwoGibsonized);
  const gibsonPlayerIds = [...new Set(gibsonPairings.flatMap((pairing) => [
    pairing.playerOneGibsonized ? pairing.playerOneId : null,
    pairing.playerTwoGibsonized ? pairing.playerTwoId : null,
  ]).filter((playerId): playerId is string => Boolean(playerId)))];
  const publishedSnapshots = card.snapshots.filter((snapshot) => Boolean(snapshot.confirmedAt));
  const latestResultGame = Math.max(0, ...publishedSnapshots.flatMap((snapshot) => snapshot.gameNumbers));
  const latestRanking = latestResultGame > 0 ? rankingAfterGame({ ...card, snapshots: publishedSnapshots }, latestResultGame) : [];
  const pairingActive = canGenerate || preview;
  const screeningAvailable = canOpenScreening(card);
  const browseGames = [...new Set(publishedSnapshots.flatMap((snapshot) => snapshot.gameNumbers))].sort((a, b) => a - b);
  const editable = editableResultGames(card);
  const chosen = browseGame?.round === card.currentGame ? browseGame.game : editable[0] ?? card.currentGame;
  const selectedBrowseGame = chosen;
  const historical = !editable.includes(selectedBrowseGame);
  const gameOptions = [...new Set([...browseGames, ...editable])].sort((a, b) => a - b).map((game) => ({
    value: String(game), label: `เกม ${game}${editable.includes(game) ? " · ปัจจุบัน" : ""}`,
  }));
  const browseSnapshot = (historical ? publishedSnapshots : card.snapshots.filter((snapshot) => !snapshot.confirmedAt))
    .find((snapshot) => snapshot.gameNumbers.includes(selectedBrowseGame));
  const browsePairings = browseSnapshot?.pairings.filter((pairing) => (pairing.gameNumber ?? selectedBrowseGame) === selectedBrowseGame) ?? [];
  const rows = !historical && preview && selectedBrowseGame === card.currentGame ? previewPairings : browsePairings;
  const searchable = rows.filter((pair) => !isVoidPairing(pair));
  const matchesNumber = (input: string | undefined, ...numbers: number[]) => !input ||
    input.split(/[\s,]+/).some((value) => numbers.includes(Number(value)));
  const contains = (text: string, value: string | undefined) => !value || text.toLocaleLowerCase().includes(value.toLocaleLowerCase());
  const fullName = (player: Player) => `${player.firstName} ${player.lastName}`;
  const visible = searchable.filter((pair) => {
    const { pair: slot, seat, code, name, school, status } = filter.state;
    const assigned = [pair.playerOneId, pair.playerTwoId].map((code) => code ? players.get(code) : undefined);
    const seats = assigned.flatMap((player, index) => player ? [(pair.tableNumber - 1) * 2 + index + 1] : []);
    const present = assigned.filter((player): player is Player => Boolean(player));
    if (!matchesNumber(slot, pair.tableNumber) || !matchesNumber(seat, ...seats)) return false;
    if (code && !present.some((player) => code.split(/[\s,]+/).some((value) => matchesPlayerCode(player.id, value)))) return false;
    if (name && !present.some((player) => contains(fullName(player), name))) return false;
    if (school && !present.some((player) => contains(player.school, school))) return false;
    if (status === "saved") return Boolean(pair.resultType);
    if (status === "waiting") return !pair.resultType;
    if (status === "penalty") return pair.resultType === "PENALTY";
    if (status === "bye") return present.length === 1;
    if (status === "school") return present.length === 2 && Boolean(present[0].school) && present[0].school === present[1].school;
    return true;
  });
  const tableIdentity = (player: Player | undefined, gibson: boolean | undefined) => <>
    <td className="code">{player?.id}</td>
    <td title={player ? fullName(player) : undefined}>{player ? fullName(player) : "บาย (ไม่มีคู่แข่ง)"}{gibson && <span className="gib" aria-label="Gibsonized">GIB</span>}</td>
    <td className="hide-mob" title={player?.school}>{player?.school}</td>
  </>;

  const generate = async () => {
    setBusy(true);
    try { await generatePairings(id); clearPairingDraft(id); }
    catch (error) { await appDialog.alert(error instanceof Error ? error.message : "สร้าง pairing ไม่สำเร็จ", "สร้าง Pairing ไม่สำเร็จ", true); }
    finally { setBusy(false); }
  };

  const swap = async (first: string, second: string, password: string) => {
    try { await swapPlayers(id, first, second, password, false, selectedBrowseGame); return true; }
    catch (error) {
      const message = error instanceof Error ? error.message : "สลับผู้เล่นไม่สำเร็จ";
      if (!message.includes("SCHOOL_CONFLICT")) throw error;
      if (!await appDialog.confirm(message.replace("SCHOOL_CONFLICT: ", ""), {
        title: "พบผู้เล่นสถาบันเดียวกัน", confirmLabel: "ยืนยันการสลับ",
      })) return false;
      await swapPlayers(id, first, second, password, true, selectedBrowseGame);
      return true;
    }
  };
  const confirm = async () => {
    if (!await appDialog.confirm(`ยืนยันคู่แข่งขันเกม ${card.currentGame}? หลังจากนี้${card.currentGame === 1 ? "จะสลับโต๊ะไม่ได้และ" : ""}จะเข้าสู่การกรอกผล`, {
      title: `ยืนยันคู่แข่งขันเกม ${card.currentGame}`,
      confirmLabel: "ยืนยันคู่แข่งขัน",
    })) return;
    setBusy(true);
    try { await confirmPairing(id); navigate(`/cards/${id}/games`); }
    catch (error) { await appDialog.alert(error instanceof Error ? error.message : "ยืนยันคู่แข่งขันไม่สำเร็จ", "ยืนยันคู่แข่งขันไม่สำเร็จ", true); }
    finally { setBusy(false); }
  };

  const undo = async () => {
    if (!await appDialog.confirm(`ลบตัวอย่างคู่แข่งขันเกม ${card.currentGame} และกลับไปสร้างคู่เกมนี้ใหม่? ผลและอันดับของเกมก่อนหน้าจะไม่เปลี่ยนแปลง`, {
      title: "สร้างคู่แข่งขันใหม่",
      confirmLabel: "ดำเนินการต่อ",
      danger: true,
    })) return;
    const password = await appDialog.prompt("กรอกรหัสผ่านผู้อำนวยการเพื่อยืนยันการยกเลิกการจับคู่", {
      title: "ยืนยันการยกเลิกการจับคู่",
      label: "รหัสผ่านผู้อำนวยการ",
      type: "password",
      confirmLabel: "ยืนยันยกเลิกการจับคู่",
    });
    if (!password) return;
    setBusy(true);
    try { await undoPairing(id, password); }
    catch (error) { await appDialog.alert(error instanceof Error ? error.message : "ยกเลิกการจับคู่ไม่สำเร็จ", "ยกเลิกการจับคู่ไม่สำเร็จ", true); }
    finally { setBusy(false); }
  };
  const canUndo = canManageTournament(auth) && preview;
  const scrollToFirstGibsonPair = () => {
    const first = gibsonPairings[0];
    if (!first) return;
    const row = document.getElementById(`gibson-pair-${id}-${first.id}`);
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (row) {
      row.classList.remove("egrid-row--gibson-focus");
      void row.offsetWidth;
      row.classList.add("egrid-row--gibson-focus");
      window.setTimeout(() => row.classList.remove("egrid-row--gibson-focus"), 1600);
    }
  };

  return <div className="director-tables">
    <h1 className="sr">โต๊ะแข่งขัน</h1>
    <div className="table-actions">
      <SelectMenu appearance="prototype" ariaLabel="เลือกเกม" options={gameOptions} value={String(selectedBrowseGame)}
        onChange={(value) => {
          setBrowseGame({ round: card.currentGame, game: Number(value) });
          filter.clear();
        }} />
      <PairingToolButtons card={card} modes={["place"]} initialGame={selectedBrowseGame} disabled={historical || !screeningAvailable || canGenerate || !rows.length} />
      {historical || pairingActive
        ? <button type="button" className="btn btn--primary" disabled>ไปหน้าผลการแข่งขัน <ArrowRight className="i" size={14} /></button>
        : <Link prefetch={false} href={`/cards/${id}/games`} className="btn btn--primary">ไปหน้าผลการแข่งขัน <ArrowRight className="i" size={14} /></Link>}
    </div>

    <section className={preview && !historical && selectedBrowseGame === card.currentGame ? "panel director-grid-panel" : "panel"} aria-label="คู่แข่งขัน" data-history={historical || undefined}>
      {preview && !historical && selectedBrowseGame === card.currentGame && previewPairings.length > 0 && <div className="director-tools" role="group" aria-label="สลับผู้เล่น">
        <div className="dir-tool-head"><span className="dir-swap-title"><Shuffle className="i" size={15} />สลับผู้เล่น</span></div>
        <div data-score-tool="swap"><DirectPlayerSwap players={card.players} pairings={previewPairings} onSwap={swap}
          disabled={busy} seats={card.slotLabel === "SEAT"} samePairAllowed={card.currentGame === 1} /></div>
      </div>}
      {!historical && canGenerate ? <div className="panel-body empty pairing-generate">
        <div className="pairing-rule"><span>รูปแบบที่ตั้งไว้สำหรับเกม {card.currentGame}</span><strong>{pairingRuleForGame(card, card.currentGame)}</strong></div>
        <button type="button" className="btn btn--primary" data-act="generate" onClick={() => void generate()} disabled={busy}><Shuffle className="i" size={16} />สร้างคู่ เกม {card.currentGame}</button>
        {Boolean(card.screeningPool?.length) && <span className="meta">คัดชั่วคราว {card.screeningPool?.length} คน</span>}
      </div> : !rows.length ? <div className="panel-body empty">ยังไม่มีคู่แข่งขัน</div> : <>
        <WorkspaceListToolbar status={<><strong>ทั้งหมด {searchable.filter((pair) => pair.playerOneId && pair.playerTwoId).length} คู่</strong>
          {searchable.some((pair) => !pair.playerOneId || !pair.playerTwoId) && <span className="meta">บาย {searchable.filter((pair) => !pair.playerOneId || !pair.playerTwoId).length}</span>}
          {filter.count > 0 && <span className="meta">แสดง {visible.length} คู่</span>}</>} actions={filter.button} />
        <div className="gscroll" style={{ maxHeight:510 }}><table className="dt" aria-label="ตารางคู่แข่งขัน">
          <thead><tr><th scope="col" className="c">{filter.heading("pair","คู่")}</th>
            <th scope="col">{filter.heading("code","รหัส 1")}</th><th scope="col">{filter.heading("name")}</th><th scope="col" className="hide-mob">{filter.heading("school")}</th>
            <th scope="col" className="pair-meet"><span className="sr">พบ</span></th>
            <th scope="col">{filter.heading("code","รหัส 2")}</th><th scope="col">{filter.heading("name")}</th><th scope="col" className="hide-mob">{filter.heading("school")}</th></tr></thead>
          <tbody>{visible.map((pair) => <tr key={pair.id} id={`gibson-pair-${id}-${pair.id}`}
            className={pair.playerOneGibsonized || pair.playerTwoGibsonized ? "gibson" : undefined}>
            <td className="c"><b>{pair.tableNumber}</b></td>
            {tableIdentity(pair.playerOneId ? players.get(pair.playerOneId) : undefined, pair.playerOneGibsonized)}
            <td className="pair-meet">พบ</td>
            {tableIdentity(pair.playerTwoId ? players.get(pair.playerTwoId) : undefined, pair.playerTwoGibsonized)}
          </tr>)}</tbody>
        </table></div>
        {!visible.length && <div className="panel-body empty">ไม่พบคู่ตามตัวกรอง</div>}
      </>}
    </section>
    <WorkspaceListFilter filter={filter} fields={["pair","seat","code","name","school"]} emptyStatus="ทุกสถานะ"
      statuses={[["waiting","รอผล"],["saved","บันทึกผลแล้ว"],["penalty","ลงดาบ"],["school","สถาบันเดียวกัน"],["bye","บาย"]]} />

    {!historical && preview && <>
      {gibsonPairings.length > 0 && <button type="button" className="notice notice--comp gibson-notice" onClick={scrollToFirstGibsonPair}>
        <Sparkles className="i" size={16} /><p><strong>มีผู้เล่น Gibsonized {gibsonPlayerIds.length} คนใน Pairing นี้</strong>
          <span>{gibsonPlayerIds.join(", ")} · กดเพื่อไปยังคู่ดังกล่าว</span></p><ArrowRight className="i" size={15} /></button>}
      <div className="pairing-approval">
        {canUndo && <button type="button" className="btn btn--secondary" onClick={() => void undo()} disabled={busy}>
          <Undo2 className="i" size={14} />ยกเลิกการจับคู่<LockKeyhole className="i" size={12} /></button>}
        <button type="button" className="btn btn--success" onClick={() => void confirm()} disabled={busy || !previewPairings.length}>
          ยืนยันคู่แข่งขัน {navPending ? <LoaderCircle className="i loading-spinner" size={14} /> : <ArrowRight className="i" size={14} />}</button>
      </div>
    </>}
    {!historical && pairingActive && latestRanking.length > 0 && <section className="panel" aria-label="อันดับล่าสุด">
      <div className="gscroll" style={{ maxHeight:420 }}><table className="dt" aria-label="ตารางอันดับล่าสุด"><thead><tr>
        <th scope="col" className="c">อันดับ</th><th scope="col">รหัส</th><th scope="col">ชื่อ–นามสกุล</th><th scope="col" className="hide-mob">โรงเรียน/สถาบัน</th><th scope="col" className="n">ชนะ / เสมอ / แพ้</th><th scope="col" className="n">คะแนนสะสม</th><th scope="col" className="n">ผลต่างสะสม</th>
      </tr></thead><tbody>{latestRanking.map((row) => <tr key={row.id}>
        <td className="c"><b>{row.displayRank}</b></td><td className="code">{row.id}</td><td>{fullName(row)}</td><td className="hide-mob">{row.school}</td>
        <td className="n">{row.wins} / {row.draws} / {row.losses}</td><td className="n">{row.winPoints}</td><td className="n">{row.diff > 0 ? "+" : ""}{row.diff}</td>
      </tr>)}</tbody></table></div>
    </section>}
  </div>;
}
