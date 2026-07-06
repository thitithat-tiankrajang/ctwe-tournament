"use client";

import Link from "next/link";
import { ArrowLeft, ChevronRight, LinkIcon, LockKeyhole, Trophy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import { usePublicSync } from "@/application/tournament/use-public-sync";
import type { TournamentCard } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";
import { CardOverview } from "@/ui/components/card-overview";
import { EmptyState, PageHeader } from "@/ui/components/page";

function cardFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const match = window.location.hash.match(/^#card=([0-9a-fA-F-]{36})$/);
  return match ? match[1] : null;
}

/**
 * The whole viewer experience lives on one URL (/tour/{token} or the legacy /t/{token}).
 *
 * Edge-request economy: the page loads ONE bundle request carrying every card's published data;
 * switching between cards is pure client state (the hash), so browsing costs zero further
 * requests. Card selection survives refresh via the hash, and a refresh revalidates the bundle by
 * ETag (usually a 304). Live updates arrive over the direct SSE stream for the open card only.
 */
export function TournamentViewer({ token }: { token: string }) {
  const enterPublicTournament = useTournamentStore((state) => state.enterPublicTournament);
  const cards = useTournamentStore((state) => state.cards);
  const auth = useTournamentStore((state) => state.auth);
  const [tournament, setTournament] = useState<{ id: string; name: string } | null>(null);
  const [dead, setDead] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(cardFromHash);

  useEffect(() => {
    let active = true;
    setDead(false);
    enterPublicTournament(token)
      .then((bundle) => { if (active) setTournament({ id: bundle.id, name: bundle.name }); })
      .catch(() => { if (active) setDead(true); });
    return () => { active = false; };
  }, [token, enterPublicTournament]);

  // Hash-only navigation between the card list and a card: browser back/forward works and the
  // server never sees these transitions.
  useEffect(() => {
    const onHashChange = () => setSelectedId(cardFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const tournamentCards = useMemo(
    () => tournament ? cards.filter((card) => card.tournamentId === tournament.id) : [],
    [cards, tournament],
  );
  const selectedCard = selectedId ? tournamentCards.find((card) => card.id === selectedId) : undefined;

  // Live results for the card being watched; staff accounts keep their own /cards sync channel.
  usePublicSync(selectedCard?.id, !auth.authenticated);

  // A single-card tournament jumps straight into that card.
  useEffect(() => {
    if (!selectedId && tournamentCards.length === 1) setSelectedId(tournamentCards[0].id);
  }, [selectedId, tournamentCards]);

  if (dead) {
    return (
      <div className="panel">
        <EmptyState
          icon={<LockKeyhole size={25} />}
          title="ลิงก์นี้ใช้ไม่ได้"
          description="การแข่งขันนี้อาจยังไม่เปิดให้เข้าชม หรือถูกปิดไปแล้ว — โปรดติดต่อผู้จัดการแข่งขัน"
          action={<Link prefetch={false} href="/"><Button variant="secondary"><LinkIcon size={16} />ไปหน้ารวมการแข่งขัน</Button></Link>}
        />
      </div>
    );
  }
  if (!tournament) return <div className="panel panel-padding">กำลังเข้าสู่การแข่งขัน…</div>;

  if (selectedCard) {
    return (
      <>
        {tournamentCards.length > 1 && (
          <a
            className="tour-back-link"
            href={window.location.pathname + window.location.search}
            onClick={(event) => {
              event.preventDefault();
              setSelectedId(null);
              window.history.pushState(null, "", window.location.pathname + window.location.search);
            }}
          >
            <ArrowLeft size={16} aria-hidden="true" /> รุ่นทั้งหมดของ {tournament.name}
          </a>
        )}
        <CardOverview cardId={selectedCard.id} />
      </>
    );
  }

  const groupedCards = [...tournamentCards]
    .sort((a, b) => a.name.localeCompare(b.name, "th", { numeric: true })
      || a.division.localeCompare(b.division, "th", { numeric: true }))
    .reduce<Map<string, TournamentCard[]>>((groups, card) => {
      const group = groups.get(card.name) ?? [];
      group.push(card);
      groups.set(card.name, group);
      return groups;
    }, new Map());

  return (
    <>
      <PageHeader
        className="cards-page-header"
        eyebrow="รายการแข่งขัน"
        title={tournament.name}
        description="เลือกรุ่นการแข่งขัน (card) เพื่อติดตามอันดับ คู่แข่งขัน และผลแบบสด"
      />
      {tournamentCards.length === 0 ? (
        <EmptyState icon={<Trophy size={25} />} title="ยังไม่มีรุ่นการแข่งขัน" description="เมื่อผู้จัดเผยแพร่รุ่นการแข่งขัน รายการจะปรากฏที่นี่" />
      ) : (
        <div className="card-groups">
          {[...groupedCards.entries()].map(([name, group]) => (
            <section className="card-group" key={name}>
              <h2 className="card-group__title">{name}</h2>
              <div className="card-group__rows">
                {group.map((card) => (
                  <article className="card-select-row" key={card.id}>
                    {/* Hash link: selecting a card is a zero-request, back-button-friendly transition. */}
                    <a href={`#card=${card.id}`} className="card-select-row__link">
                      <span className="card-select-row__name">{card.name}</span>
                      <span className="card-select-row__division">{card.division}</span>
                      <ChevronRight size={19} aria-hidden />
                    </a>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
