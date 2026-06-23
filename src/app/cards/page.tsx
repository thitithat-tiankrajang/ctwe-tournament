"use client";

import Link from "next/link";
import { ArrowRight, Plus, Trophy } from "lucide-react";
import { useTournamentStore } from "@/application/tournament/store";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { EmptyState, PageHeader, Stat } from "@/ui/components/page";

export default function CardsPage() {
  const cards = useTournamentStore((state) => state.cards);
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const error = useTournamentStore((state) => state.error);
  const isStaff = auth.authenticated && auth.roles.includes("ROLE_STAFF");
  const running = cards.filter((card) => card.status === "RUNNING").length;
  const totalPlayers = cards.reduce((sum, card) => sum + card.players.length, 0);
  const finished = cards.filter((card) => ["FINISHED", "CLOSED"].includes(card.status)).length;
  const cardHref = (card: typeof cards[number]) => {
    if (!isStaff || card.runtimeStage === "FINAL_PUBLISHED") return `/cards/${card.id}`;
    if (card.runtimeStage === "PLAYER_REGISTRATION") return `/cards/${card.id}/players`;
    if (["TABLE_PAIRING", "PAIRING_PREVIEW"].includes(card.runtimeStage)) return `/cards/${card.id}/tables`;
    return `/cards/${card.id}/games`;
  };

  return (
    <>
      <PageHeader
        eyebrow="Tournament cards"
        title="การ์ดการแข่งขัน"
        description="หนึ่งการ์ดต่อหนึ่งรุ่นการแข่งขัน จัดการผู้เล่น เกม และผลลัพธ์แยกจากกันอย่างชัดเจน"
        actions={isStaff ? <Link href="/cards/create"><Button><Plus size={17} />สร้างการ์ด</Button></Link> : undefined}
      />
      {error && <div className="notice notice--warning"><p><strong>เชื่อมต่อฐานข้อมูลไม่สำเร็จ</strong><span>{error}</span></p></div>}
      <div className="stat-grid">
        <Stat label="การ์ดทั้งหมด" value={cards.length} note="ทุกสถานะ" />
        <Stat label="กำลังแข่งขัน" value={running} tone="yellow" note="ต้องติดตามผล" />
        <Stat label="ผู้เล่นในระบบ" value={totalPlayers.toLocaleString("th-TH")} tone="blue" note="รวมทุกการ์ด" />
        <Stat label="แข่งขันเสร็จแล้ว" value={finished} tone="green" note="พร้อมส่งออกข้อมูล" />
      </div>
      {loading ? <div className="panel panel-padding">กำลังโหลดข้อมูลจากฐานข้อมูล…</div> : cards.length === 0 ? (
        <EmptyState icon={<Trophy size={25} />} title="ยังไม่มีการ์ดการแข่งขัน" description="ยังไม่มีการแข่งขันที่เผยแพร่" action={isStaff ? <Link href="/cards/create"><Button>สร้างการ์ด</Button></Link> : undefined} />
      ) : (
        <div className="card-grid">
          {cards.map((card) => (
            <article className="competition-card" key={card.id}>
              <div className="competition-card__header">
                <div><h2>{card.name}</h2><span className="competition-card__division">{card.division}</span></div>
                <Badge>{card.status}</Badge>
              </div>
              <div className="competition-card__metrics">
                <div className="competition-card__metric"><span>ผู้เล่น</span><strong>{card.players.length}</strong></div>
                <div className="competition-card__metric"><span>เกม</span><strong>{card.games.length}</strong></div>
                <div className="competition-card__metric"><span>เกมปัจจุบัน</span><strong>{card.currentGame}/{card.games.length}</strong></div>
              </div>
              <div className="competition-card__footer">
                <small>สร้างเมื่อ {new Intl.DateTimeFormat("th-TH", { dateStyle: "medium" }).format(new Date(card.createdAt))}</small>
                <Link href={cardHref(card)}><Button variant="ghost" size="sm">{isStaff && card.runtimeStage !== "FINAL_PUBLISHED" ? "ทำงานต่อ" : "ดูภาพรวม"} <ArrowRight size={15} /></Button></Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
