"use client";

import { ArrowLeft, ChevronRight, LockKeyhole, PowerOff, Trophy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import { fetchSystemState, systemIsOff, type SystemState } from "@/infrastructure/http/system-state";
import { usePublicBundleSync, usePublicSync } from "@/application/tournament/use-public-sync";
import type { TournamentCard } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { CardOverview } from "@/ui/components/card-overview";
import { EmptyState, PageHeader } from "@/ui/components/page";
import { cardStageInfo } from "@/ui/components/stage-info";

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
  // Resolved from a published CDN snapshot rather than the live API: finished, immutable, and
  // served without contacting the backend at all.
  const published = useTournamentStore((state) => state.activeTournament?.published === true);
  const [tournament, setTournament] = useState<{ id: string; name: string } | null>(null);
  const [dead, setDead] = useState(false);
  /** Set only when a failed load coincides with a declared system-off state (§20). */
  const [systemState, setSystemState] = useState<SystemState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(cardFromHash);
  const autoOpenedSingleCard = useRef(false);

  useEffect(() => {
    let active = true;
    autoOpenedSingleCard.current = false;
    setDead(false);
    setSystemState(null);
    enterPublicTournament(token)
      .then((bundle) => { if (active) setTournament({ id: bundle.id, name: bundle.name }); })
      .catch(async () => {
        if (!active) return;
        // Architecture §20: an unpublished tournament whose live fetch failed looks identical to a
        // dead link. The state file is the only thing that can tell them apart, and it is consulted
        // ONLY on this failure path — never on a successful load, and never on the published path,
        // so Phase D's zero-origin-request guarantee is untouched either way.
        const state = await fetchSystemState();
        if (!active) return;
        setSystemState(state);
        setDead(true);
      });
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
  // The card list has no SSE channel of its own — keep it live (new cards, stage badges) while
  // it is what the viewer is looking at, so nobody has to refresh to see a newly created card.
  usePublicBundleSync(token, !auth.authenticated && !dead && tournament !== null && !selectedCard);

  // A single-card tournament jumps straight into that card.
  useEffect(() => {
    if (selectedId || tournamentCards.length !== 1 || autoOpenedSingleCard.current) return;
    autoOpenedSingleCard.current = true;
    const cardId = tournamentCards[0].id;
    setSelectedId(cardId);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#card=${cardId}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, [selectedId, tournamentCards]);

  if (dead) {
    // "The system is off" and "this link is dead" are the same failure to the browser but entirely
    // different news to a viewer: one is temporary and nobody's fault, the other means the link
    // will never work again. Saying the wrong one sends people to the organizer for no reason.
    const off = systemIsOff(systemState);
    return (
      <div className="panel">
        <EmptyState
          icon={off ? <PowerOff size={25} /> : <LockKeyhole size={25} />}
          title={off ? "ระบบจัดการแข่งขันปิดอยู่" : "ลิงก์นี้ใช้ไม่ได้"}
          description={off
            ? "ขณะนี้ไม่มีการจัดการแข่งขันอยู่ — ผลการแข่งขันที่เผยแพร่แล้วยังเปิดดูได้ตามปกติ โปรดลองใหม่อีกครั้งภายหลัง"
            : "การแข่งขันนี้อาจยังไม่เปิดให้เข้าชม หรือถูกปิดไปแล้ว — โปรดติดต่อผู้จัดการแข่งขันเพื่อขอลิงก์ใหม่"}
        />
      </div>
    );
  }
  if (!tournament) return <div className="panel panel-padding">กำลังเข้าสู่การแข่งขัน…</div>;

  if (selectedCard) {
    const leaveCard = () => {
      setSelectedId(null);
      window.history.pushState(null, "", window.location.pathname + window.location.search);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    };
    return (
      <>
        {/* One back control for every viewport: a link-style row on desktop, the fixed top bar on phones. */}
        <button type="button" className={`tour-card-back${auth.authenticated ? " tour-card-back--authenticated" : ""}`} onClick={leaveCard} aria-label={`กลับไปเลือกรุ่นของ ${tournament.name}`}>
          <ArrowLeft size={18} aria-hidden="true" />
          <Trophy className="tour-card-back__trophy" size={19} aria-hidden="true" />
          <span className="tour-card-back__text"><span className="tour-card-back__prefix">รุ่นทั้งหมดของ </span>{tournament.name}</span>
        </button>
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
        title={tournament.name}
        description={published
          ? "การแข่งขันนี้จบแล้ว — ผลการแข่งขันฉบับเผยแพร่ถาวร"
          : "เลือกรุ่นการแข่งขัน เพื่อติดตามอันดับ ผลประกบคู่ และผลการแข่งขัน"}
      />
      {tournamentCards.length === 0 ? (
        <EmptyState icon={<Trophy size={25} />} title="ยังไม่มีรุ่นการแข่งขัน" description="เมื่อผู้จัดเผยแพร่รุ่นการแข่งขัน รายการจะปรากฏที่นี่" />
      ) : (
        <div className="card-groups">
          {[...groupedCards.entries()].map(([name, group]) => (
            <section className="card-group" key={name}>
              <h2 className="card-group__title">{name}</h2>
              <div className="card-group__rows">
                {group.map((card) => {
                  const stage = cardStageInfo(card, "viewer");
                  return (
                    <article className="card-select-row" key={card.id}>
                      {/* Hash link: selecting a card is a zero-request, back-button-friendly transition. */}
                      <a href={`#card=${card.id}`} className="card-select-row__link">
                        <span className="card-select-row__name">{card.division}</span>
                        <span className="card-select-row__stage"><Badge tone={stage.tone}>{stage.label}</Badge></span>
                        <ChevronRight size={19} aria-hidden />
                      </a>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
