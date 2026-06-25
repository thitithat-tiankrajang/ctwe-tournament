"use client";

import { Beaker, FastForward, LockKeyhole, RotateCcw, School, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import { isAdmin } from "@/domain/tournament/roles";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { EmptyState, PageHeader, Panel } from "@/ui/components/page";

export default function DevToolsPage() {
  const cards = useTournamentStore((state) => state.cards);
  const generatePlayers = useTournamentStore((state) => state.generateMockPlayers);
  const finishRegistration = useTournamentStore((state) => state.finishRegistration);
  const generatePairings = useTournamentStore((state) => state.generatePairings);
  const simulate = useTournamentStore((state) => state.simulateTournament);
  const resetCard = useTournamentStore((state) => state.resetCard);
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const [cardId, setCardId] = useState(cards[0]?.id ?? "");
  const card = cards.find((item) => item.id === cardId);
  useEffect(() => {
    if (!cardId && cards[0]) setCardId(cards[0].id);
  }, [cardId, cards]);
  const locked = card?.status === "CLOSED";
  const run = async (action: () => Promise<void>, message: string) => {
    try { await action(); window.alert(message); }
    catch (error) { window.alert(error instanceof Error ? error.message : "เกิดข้อผิดพลาด"); }
  };
  const preparePairing = async () => {
    if (card?.runtimeStage === "PLAYER_REGISTRATION") await finishRegistration(cardId);
    await generatePairings(cardId);
  };
  if (loading) return <div className="panel panel-padding">กำลังตรวจสอบสิทธิ์…</div>;
  if (!isAdmin(auth)) {
    return <div className="panel"><EmptyState icon={<LockKeyhole size={25} />} title="สำหรับเจ้าหน้าที่เท่านั้น" description="บุคคลทั่วไปสามารถดูข้อมูลการแข่งขันได้ แต่ไม่สามารถใช้เครื่องมือที่เปลี่ยนแปลงข้อมูล" /></div>;
  }
  return (
    <>
      <PageHeader eyebrow="Developer utilities" title="เครื่องมือนักพัฒนา" description="สร้างข้อมูลจำนวนมากและจำลอง workflow เพื่อทดสอบ pairing และ ranking โดยไม่ต้องกรอกข้อมูลด้วยตนเอง" actions={<Badge tone="warning">POSTGRESQL · STAFF ONLY</Badge>} />
      <div className="notice notice--warning"><Beaker size={19} /><p><strong>พื้นที่สำหรับการทดสอบเท่านั้น</strong><span>การทำงานในหน้านี้เปลี่ยนข้อมูลของการ์ดทันที และจะสร้าง audit log ตามปกติ</span></p></div>
      <Panel title="การ์ดเป้าหมาย" description="เลือกการ์ดก่อนเรียกใช้เครื่องมือ"><div className="panel-padding form-grid"><div className="form-field"><label className="form-label">การ์ดการแข่งขัน</label><select className="select" value={cardId} onChange={(event) => setCardId(event.target.value)}>{cards.map((item) => <option key={item.id} value={item.id}>{item.name} — {item.division}</option>)}</select></div><div className="form-field"><label className="form-label">สถานะปัจจุบัน</label><div className="input" style={{ display: "flex", alignItems: "center", gap: 10 }}><Badge>{card?.status ?? "—"}</Badge><span>{card?.players.length ?? 0} ผู้เล่น · {card?.games.length ?? 0} เกม</span></div></div></div></Panel>
      <div className="dev-grid">
        <section className="dev-action"><h2><Users size={19} />สร้าง Mock Players</h2><p>แทนที่รายชื่อปัจจุบันด้วยข้อมูลผู้เล่นที่กระจายหลายโรงเรียน</p><div className="page-actions" style={{ justifyContent: "flex-start" }}><Button variant="secondary" disabled={!cardId || locked} onClick={() => run(() => generatePlayers(cardId, 300), "สร้างผู้เล่น 300 คนแล้ว")}>300 คน</Button><Button disabled={!cardId || locked} onClick={() => run(() => generatePlayers(cardId, 1000), "สร้างผู้เล่น 1,000 คนแล้ว")}>1,000 คน</Button></div></section>
        <section className="dev-action"><h2><School size={19} />เตรียม Pairing</h2><p>จบการลงทะเบียนและสร้าง pairing preview ตาม workflow</p><Button disabled={!cardId || locked || !card?.players.length || !["PLAYER_REGISTRATION", "TABLE_PAIRING"].includes(card?.runtimeStage ?? "")} onClick={() => run(preparePairing, "สร้าง pairing preview แล้ว")}>สร้างโต๊ะ/Pairing</Button></section>
        <section className="dev-action"><h2><FastForward size={19} />จำลองการแข่งขันเต็มรูปแบบ</h2><p>สร้างผลทุกเกม snapshot ถาวร และอันดับสุดท้ายในครั้งเดียว</p><Button variant="success" disabled={!cardId || locked || !card?.players.length} onClick={() => run(() => simulate(cardId), "จำลองการแข่งขันครบทุกเกมแล้ว")}>Simulate Tournament</Button></section>
        <section className="dev-action danger-zone"><h2><RotateCcw size={19} />รีเซ็ตการ์ด</h2><p>ล้างผล โต๊ะ และ snapshot แต่เก็บรายชื่อกับโครงสร้างเกมไว้</p><Button variant="danger" disabled={!cardId || locked} onClick={() => window.confirm("รีเซ็ตข้อมูล runtime ของการ์ดนี้หรือไม่?") && void resetCard(cardId)}>Reset Card</Button></section>
      </div>
    </>
  );
}
