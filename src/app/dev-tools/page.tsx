"use client";

import { FastForward, LockKeyhole, RotateCcw, School, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { selectCardList, useTournamentStore } from "@/application/tournament/store";
import { appDialog } from "@/application/ui/dialog";
import { toast } from "@/application/ui/toast";
import { isAdmin } from "@/domain/tournament/roles";
import type { BadgeTone } from "@/ui/components/badge";
import { EmptyState } from "@/ui/components/page";
import { SelectMenu } from "@/ui/components/select-menu";

const statusTone: Record<string, BadgeTone> = { READY: "info", RUNNING: "warning", FINISHED: "success", CLOSED: "danger" };

export default function DevToolsPage() {
  const cards = useTournamentStore((state) => state.cards);
  const generatePlayers = useTournamentStore((state) => state.generateMockPlayers);
  const finishRegistration = useTournamentStore((state) => state.finishRegistration);
  const generatePairings = useTournamentStore((state) => state.generatePairings);
  const simulate = useTournamentStore((state) => state.simulateTournament);
  const resetCard = useTournamentStore((state) => state.resetCard);
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const summaries = useTournamentStore((state) => state.summaries);
  const rows = useMemo(() => selectCardList(cards, summaries), [cards, summaries]);
  const [cardId, setCardId] = useState(rows[0]?.id ?? "");
  const row = rows.find((item) => item.id === cardId);
  useEffect(() => {
    if (!cardId && rows[0]) setCardId(rows[0].id);
  }, [cardId, rows]);
  const locked = row?.status === "CLOSED";
  const run = async (action: () => Promise<void>, message: string) => {
    try { await action(); toast.success(message); }
    catch (error) { await appDialog.alert(error instanceof Error ? error.message : "เกิดข้อผิดพลาด", "ดำเนินการไม่สำเร็จ", true); }
  };
  const preparePairing = async () => {
    if (row?.runtimeStage === "PLAYER_REGISTRATION") await finishRegistration(cardId);
    await generatePairings(cardId);
  };
  if (loading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;
  if (!isAdmin(auth)) {
    return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับผู้ดูแลระบบเท่านั้น" description="เครื่องมือนักพัฒนาเปลี่ยนแปลงข้อมูลการแข่งขันโดยตรง จึงเปิดให้เฉพาะผู้ดูแลระบบ" /></div>;
  }
  return (
    <>
      <div className="page-head"><div className="ttl"><h1>เครื่องมือนักพัฒนา</h1>
        <span className="desc">สร้างข้อมูลจำนวนมากและจำลอง workflow เพื่อทดสอบ pairing และ ranking โดยไม่ต้องกรอกข้อมูลด้วยตนเอง</span></div>
        <div className="actions"><span className="badge badge--warning">ADMIN ONLY</span></div></div>
      <div className="notice notice--warning"><p><strong>พื้นที่สำหรับการทดสอบเท่านั้น</strong><span>การทำงานในหน้านี้เปลี่ยนข้อมูลของการ์ดทันที และจะสร้าง audit log ตามปกติ</span></p></div>
      <section className="panel">
        <div className="panel-head"><h2>การ์ดเป้าหมาย</h2><span className="desc">เลือกการ์ดก่อนเรียกใช้เครื่องมือ</span></div>
        <div className="panel-body"><div className="form-row">
          <div className="field"><span className="field__label">การ์ดการแข่งขัน</span>
            <SelectMenu appearance="prototype" className="sm--block" ariaLabel="การ์ดการแข่งขัน" value={cardId}
              options={rows.map((item) => ({ value: item.id, label: `${item.name} · ${item.division}` }))} onChange={setCardId} /></div>
          <div className="field"><span className="field__label">สถานะปัจจุบัน</span>
            <span className="dev-status"><span className={`badge badge--${statusTone[row?.status ?? ""] ?? "neutral"}`}>{row?.status ?? "—"}</span>
              <span className="meta">{row?.playerCount ?? 0} ผู้เล่น · {row?.gameCount ?? 0} เกม</span></span></div>
        </div></div>
      </section>
      <div className="dev-grid">
        <section className="panel"><div className="panel-head"><h2><Users className="i" size={16} />สร้าง Mock Players</h2><span className="desc">แทนที่รายชื่อปัจจุบันด้วยข้อมูลผู้เล่นที่กระจายหลายโรงเรียน</span></div>
          <div className="panel-body cellrow">
            <button type="button" className="btn btn--secondary" disabled={!cardId || locked} onClick={() => run(() => generatePlayers(cardId, 300), "สร้างผู้เล่น 300 คนแล้ว")}>300 คน</button>
            <button type="button" className="btn btn--secondary" disabled={!cardId || locked} onClick={() => run(() => generatePlayers(cardId, 400), "สร้างผู้เล่น 400 คนแล้ว")}>400 คน</button>
            <button type="button" className="btn btn--primary" disabled={!cardId || locked} onClick={() => run(() => generatePlayers(cardId, 1000), "สร้างผู้เล่น 1,000 คนแล้ว")}>1,000 คน</button>
          </div></section>
        <section className="panel"><div className="panel-head"><h2><School className="i" size={16} />เตรียม Pairing</h2><span className="desc">จบการลงทะเบียนและสร้าง pairing preview ตาม workflow</span></div>
          <div className="panel-body"><button type="button" className="btn btn--primary" disabled={!cardId || locked || !row?.playerCount || !["PLAYER_REGISTRATION", "TABLE_PAIRING"].includes(row?.runtimeStage ?? "")}
            onClick={() => run(preparePairing, "สร้าง pairing preview แล้ว")}>สร้างโต๊ะ/Pairing</button></div></section>
        <section className="panel"><div className="panel-head"><h2><FastForward className="i" size={16} />จำลองการแข่งขันเต็มรูปแบบ</h2><span className="desc">สร้างผลทุกเกม snapshot ถาวร และอันดับสุดท้ายในครั้งเดียว</span></div>
          <div className="panel-body"><button type="button" className="btn btn--success" disabled={!cardId || locked || !row?.playerCount}
            onClick={() => run(() => simulate(cardId), "จำลองการแข่งขันครบทุกเกมแล้ว")}>Simulate Tournament</button></div></section>
        <section className="panel danger-zone"><div className="panel-head"><h2><RotateCcw className="i" size={16} />รีเซ็ตการ์ด</h2><span className="desc">ล้างผล โต๊ะ และ snapshot แต่เก็บรายชื่อกับโครงสร้างเกมไว้</span></div>
          <div className="panel-body"><button type="button" className="btn btn--danger" disabled={!cardId || locked} onClick={async () => {
            if (await appDialog.confirm("รีเซ็ตข้อมูล runtime ของการ์ดนี้หรือไม่?", { title: "Reset Card", confirmLabel: "Reset Card", danger: true })) await resetCard(cardId);
          }}>Reset Card</button></div></section>
      </div>
    </>
  );
}
