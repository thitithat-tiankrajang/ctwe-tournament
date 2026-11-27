"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Trophy } from "lucide-react";
import { useEffect, useMemo } from "react";
import { selectCardList, useTournamentStore, type CardListRow } from "@/application/tournament/store";
import { isDirector, isOperator } from "@/domain/tournament/roles";
import { EmptyState } from "@/ui/components/page";
import { operatorStageLabels } from "@/ui/components/stage-info";

function cardRoute(card: CardListRow, operator: boolean, director: boolean) {
  const href = `/cards/${card.id}`;
  if (!operator || card.status === "CLOSED" || card.status === "FINISHED" || card.runtimeStage === "FINAL_PUBLISHED")
    return { href, step: "ภาพรวม" };
  if (card.runtimeStage === "PLAYER_REGISTRATION") return director
    ? { href: `${href}/players`, step: "ทำต่อ: ผู้เล่น" } : { href, step: "ภาพรวม" };
  if (card.runtimeStage === "TABLE_PAIRING" || card.runtimeStage === "PAIRING_PREVIEW") return director
    ? { href: `${href}/tables`, step: "ทำต่อ: โต๊ะแข่งขัน" } : { href, step: "ภาพรวม" };
  return { href: `${href}/games`, step: "ทำต่อ: ผลการแข่งขัน" };
}

function cardStatus(card: CardListRow) {
  if (card.status === "CLOSED") return ["closed", "ปิดการ์ดแล้ว"];
  if (card.status === "FINISHED" || card.runtimeStage === "FINAL_PUBLISHED") return ["done", "จบการแข่งขันแล้ว"];
  if (card.runtimeStage.startsWith("FINAL")) return ["final", "รอบชิงชนะเลิศ"];
  if (card.runtimeStage === "PLAYER_REGISTRATION") return ["idle", "ยังไม่เริ่ม"];
  return ["live", `เกม ${card.currentGame}/${card.gameCount} · ${operatorStageLabels[card.runtimeStage]}`];
}

export default function CardsPage() {
  const router = useRouter();
  const cards = useTournamentStore((state) => state.cards);
  const summaries = useTournamentStore((state) => state.summaries);
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  const error = useTournamentStore((state) => state.error);
  const tournament = useTournamentStore((state) => state.activeTournament);
  const director = isDirector(auth);
  const operator = isOperator(auth);
  const groups = useMemo(() => {
    const rows = selectCardList(cards, summaries).filter((card) => card.tournamentId === tournament?.id)
      .sort((left, right) => left.name.localeCompare(right.name, "th", { numeric: true })
        || left.division.localeCompare(right.division, "th", { numeric: true }));
    const grouped = new Map<string, CardListRow[]>();
    for (const row of rows) {
      const group = grouped.get(row.name) ?? [];
      group.push(row);
      grouped.set(row.name, group);
    }
    return { count: rows.length, grouped };
  }, [cards, summaries, tournament?.id]);
  const prefixes = useMemo(() => new Map(cards.flatMap((card) => card.codePrefix ? [[card.id, card.codePrefix]] : [])), [cards]);

  useEffect(() => {
    if (!loading && !tournament) router.replace("/");
  }, [loading, tournament, router]);

  return <>
    <div className="page-head"><div className="ttl">
      <span className="eyebrow">รายการแข่งขัน</span>
      <h1>{tournament?.name ?? "รายการแข่งขันทั้งหมด"}</h1>
      <span className="desc">{groups.count} การ์ด</span>
    </div></div>
    {error && <div className="notice notice--warning" role="alert"><p><strong>เชื่อมต่อฐานข้อมูลไม่สำเร็จ</strong><span>{error}</span></p></div>}
    {loading ? <div className="panel panel-body" role="status">กำลังโหลดข้อมูลการแข่งขัน…</div> : groups.count === 0 ? (
      <EmptyState icon={<Trophy size={25} />} title="ยังไม่มีการ์ดในรายการนี้"
        description={director ? "เพิ่มรุ่นการแข่งขันได้ในคอนโซลผู้อำนวยการ" : "รุ่นการแข่งขันจะปรากฏที่นี่เมื่อพร้อม"} />
    ) : [...groups.grouped].map(([name, group]) => (
      <section className="panel panel--blue" key={name} id={`sport-${encodeURIComponent(name)}`}>
        <div className="panel-head"><h2 className="cards-sport-title">{name}</h2><span className="desc">{group.length} รุ่น</span></div>
        {group.map((card) => {
          const [status, label] = cardStatus(card);
          const { href, step } = cardRoute(card, operator, director);
          const prefix = prefixes.get(card.id);
          return <div className="crow" key={card.id}>
            <Link prefetch={false} href={href} className="crow__main">
              <span className={`strip strip--${status}`} aria-hidden />
              <span className="crow__name">{card.division}</span>
              <span className="crow__meta">{prefix && <><span className="code">{prefix}</span> · </>}{card.playerCount} คน</span>
              <span className="crow__stat">{label}</span>
              <span className="crow__go">{step}<ArrowRight className="i" size={14} aria-hidden /></span>
            </Link>
          </div>;
        })}
      </section>
    ))}
  </>;
}
