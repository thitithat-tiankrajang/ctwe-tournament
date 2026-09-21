"use client";

import { ArrowLeft, ChevronRight, LockKeyhole, PowerOff, Trophy } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createSpectatorState } from "@/application/tournament/spectator-state";
import { legacyPublicCard } from "@/application/tournament/spectator-read-model";
import { attemptReportScroll, createReportScrollOwner } from "@/application/tournament/spectator-report-scroll";
import { parseSpectatorHash, spectatorHash, spectatorReportContextFromHistory, SPECTATOR_HOME, type SpectatorReportContext, type SpectatorRoute } from "@/application/tournament/spectator-route";
import { searchCoverageComplete, searchParticipants, type SpectatorSearchCriteria, type SpectatorSearchResult } from "@/application/tournament/spectator-search";
import { fetchSystemState, systemIsOff, type SystemState } from "@/infrastructure/http/system-state";
import { useSpectatorSync } from "@/application/tournament/use-spectator-sync";
import type { TournamentCard } from "@/domain/tournament/types";
import { Badge } from "@/ui/components/badge";
import { CardOverviewView } from "@/ui/components/card-overview-view";
import { EmptyState, PageHeader } from "@/ui/components/page";
import { SpectatorFind } from "@/ui/components/spectator-find";
import { SpectatorParticipation } from "@/ui/components/spectator-participation";
import { cardStageInfo } from "@/ui/components/stage-info";

function currentRoute(): SpectatorRoute {
  if (typeof window === "undefined") return SPECTATOR_HOME;
  return parseSpectatorHash(window.location.hash);
}

const EMPTY_CRITERIA: SpectatorSearchCriteria = { query: "", divisionId: null, school: null };

/** The search state a fragment carries, so Back restores what was typed, not an empty box. */
function routeCriteria(route: SpectatorRoute): SpectatorSearchCriteria {
  return route.kind === "find"
    ? { query: route.query, divisionId: route.divisionId, school: route.school }
    : EMPTY_CRITERIA;
}

/**
 * The whole viewer experience lives on one URL (/tour/{token} or the legacy /t/{token}).
 *
 * Edge-request economy: the page loads ONE bundle request carrying every card's published data, so
 * finding a player, reading their participation and browsing the division reports are all pure
 * fragment transitions costing zero further requests. Every destination is a real history entry, so
 * Back walks player → search → entrance with the search query intact. Live updates arrive over the
 * direct SSE stream for whichever division is open.
 */
export function TournamentViewer({ token }: { token: string }) {
  const store = useMemo(() => createSpectatorState(token), [token]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const cards = useMemo(() => state.cards.map(legacyPublicCard), [state.cards]);
  const published = state.source === "archive";
  const tournament = state.tournament;
  const [dead, setDead] = useState(false);
  /** Set only when a failed load coincides with a declared system-off state (§20). */
  const [systemState, setSystemState] = useState<SystemState | null>(null);
  const [route, setRoute] = useState<SpectatorRoute>(currentRoute);
  const [criteria, setCriteria] = useState<SpectatorSearchCriteria>(() => routeCriteria(currentRoute()));
  /** Whether this visit has a history entry of its own to go back to (see `leavePlayer`). */
  const pushedOwnEntry = useRef(false);
  const reportScroll = useMemo(createReportScrollOwner, []);
  const pendingPlayerTop = useRef<string | null>(null);
  const lastReportContext = useRef<{ cardId: string; context: SpectatorReportContext } | null>(null);

  useEffect(() => {
    let active = true;
    const initial = currentRoute();
    setRoute(initial);
    setCriteria(routeCriteria(initial));
    setDead(false);
    setSystemState(null);
    store.load()
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
  }, [store]);

  // Fragment-only navigation: the browser back/forward buttons work and the server never sees these
  // transitions. Native `#card=` links (the browse list) arrive here too. `pushState` transitions
  // are observed by popstate; hashchange covers native anchor links as well.
  useEffect(() => {
    let timer: number | undefined;
    const syncHistoryRoute = () => {
      const next = currentRoute();
      const rawContext = next.kind === "card" ? spectatorReportContextFromHistory(window.history.state) : null;
      const context = next.kind === "card" && rawContext && (
        rawContext.cardId === next.cardId
        || (!rawContext.cardId && lastReportContext.current?.cardId === next.cardId)
      ) ? rawContext : null;
      if (next.kind === "card" && context) reportScroll.stage(next.cardId, context.scrollY);
      else reportScroll.cancel();
      setRoute(next);
      setCriteria(routeCriteria(next));
    };
    // Chromium emits both popstate and hashchange for a fragment history traversal. Coalesce the
    // pair into one route transition so one event cannot tear down report restoration prematurely.
    const onHistoryChange = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = undefined; syncHistoryRoute(); }, 0);
    };
    window.addEventListener("hashchange", onHistoryChange);
    window.addEventListener("popstate", onHistoryChange);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("hashchange", onHistoryChange);
      window.removeEventListener("popstate", onHistoryChange);
    };
  }, [reportScroll]);

  /**
   * `replace` is for refining what you are already looking at (each keystroke of a search); `push`
   * is for going somewhere. Typing must not bury the entrance under a hundred history entries, and
   * opening a player must always be one Back away from the search that found them.
   */
  const navigate = useCallback((next: SpectatorRoute, mode: "push" | "replace" = "push") => {
    // A pending target belongs only to the report entry reached by Back. Leaving that entry before
    // its frame runs must invalidate it synchronously so it cannot jump a later destination.
    reportScroll.cancel();
    const url = `${window.location.pathname}${window.location.search}${spectatorHash(next)}`;
    // Preserve any context attached to this history entry. Reports annotate their entry before
    // opening Player, allowing Back to recover the same lens without changing the public URL.
    window.history[mode === "push" ? "pushState" : "replaceState"](window.history.state ?? null, "", url);
    if (mode === "push") {
      pushedOwnEntry.current = true;
      pendingPlayerTop.current = next.kind === "player" ? `${next.divisionId}:${next.code}` : null;
    } else if (next.kind !== "player") {
      pendingPlayerTop.current = null;
    }
    setRoute(next);
    setCriteria(routeCriteria(next));
  }, [reportScroll]);

  const rememberReportContext = useCallback((cardId: string, context: SpectatorReportContext) => {
    lastReportContext.current = { cardId, context };
    const current = window.history.state;
    const scopedContext = { ...context, cardId };
    const state = current && typeof current === "object" ? { ...current, spectatorReport: scopedContext } : { spectatorReport: scopedContext };
    window.history.replaceState(state, "", window.location.href);
  }, []);

  const tournamentCards = useMemo(
    () => tournament ? cards.filter((card) => card.tournamentId === tournament.id) : [],
    [cards, tournament],
  );
  const divisions = useMemo(
    () => tournament ? state.divisions.filter((division) => division.tournamentId === tournament.id) : [],
    [state.divisions, tournament],
  );
  const selectedCard = route.kind === "card" ? tournamentCards.find((card) => card.id === route.cardId) : undefined;
  const playerDivision = route.kind === "player" ? divisions.find((division) => division.id === route.divisionId) : undefined;
  const playerCard = playerDivision ? state.cards.find((card) => card.id === playerDivision.id) : undefined;
  const reportContext = route.kind === "card" ? (() => {
    const rawContext = spectatorReportContextFromHistory(typeof window === "undefined" ? null : window.history.state);
    if (!rawContext) return null;
    // New entries carry their division explicitly. The fallback keeps a same-session entry written
    // before this scope was added usable, while preventing an old lens from configuring another card.
    return rawContext.cardId === route.cardId
      || (!rawContext.cardId && lastReportContext.current?.cardId === route.cardId)
      ? rawContext : null;
  })() : null;

  // React replaces the report subtree when Back returns from Player. Restore after that subtree has
  // laid out, while leaving the browser's native history mechanism in charge everywhere else.
  useEffect(() => {
    // The route changes before the public payload has necessarily rendered. Keep ownership until
    // the matching card subtree exists; an effect cleanup is not proof that restoration happened.
    if (route.kind !== "card" || !selectedCard) return;
    const target = reportScroll.targetFor(route.cardId);
    if (!target) return;
    const frame = window.requestAnimationFrame(() => {
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      // `scrollTo` is synchronous for behavior:auto. Clear only after the document reached the
      // requested position (or its current clamp when realtime made the report shorter).
      attemptReportScroll(
        reportScroll,
        target,
        maxScroll,
        (scrollY) => window.scrollTo({ top: scrollY, behavior: "auto" }),
        () => window.scrollY,
      );
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [reportScroll, route, selectedCard?.id]);

  // Forward fragment navigation starts a Player at the top. Browser Back/Forward and explicit
  // report restoration do not set this marker and therefore retain their existing scroll context.
  useEffect(() => {
    const target = pendingPlayerTop.current;
    if (!target) return;
    if (route.kind !== "player") {
      pendingPlayerTop.current = null;
      return;
    }
    if (!playerCard || `${route.divisionId}:${route.code}` !== target) return;
    pendingPlayerTop.current = null;
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [route, playerCard?.id]);

  // Native restoration can race the public subtree replacement. Manual restoration makes the one
  // explicit report context deterministic, and the previous setting is put back on unmount.
  useEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => { window.history.scrollRestoration = previous; };
  }, []);

  // One open division at a time drives the live stream: the player destination follows the division
  // it belongs to, and the entrance/search listens to the tournament-level list instead.
  useSpectatorSync(store, selectedCard?.id ?? playerDivision?.id ?? null, state.source);

  const changeCriteria = (next: SpectatorSearchCriteria) => {
    setCriteria(next);
    navigate({ kind: "find", query: next.query, divisionId: next.divisionId, school: next.school },
      route.kind === "find" ? "replace" : "push");
  };
  const openPlayer = (result: SpectatorSearchResult) =>
    navigate({ kind: "player", divisionId: result.divisionId, code: result.code });
  const openPlayerFromReport = (divisionId: string, code: string, context: SpectatorReportContext) => {
    rememberReportContext(divisionId, context);
    navigate({ kind: "player", divisionId, code });
  };
  // A code that identifies exactly one player in the whole event is an answer, not a result list —
  // but only on an explicit submit, and only while every division's roster is actually public.
  const submitSearch = () => {
    const outcome = searchParticipants(divisions, criteria);
    if (outcome.uniqueExactCode && searchCoverageComplete(divisions)) openPlayer(outcome.uniqueExactCode);
  };

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

  const freshnessNotice = state.freshness === "reconnecting" || state.freshness === "delayed"
    ? <p className="spectator-freshness" role="status">การอัปเดตอาจล่าช้า — แสดงข้อมูลล่าสุดที่ได้รับ <button type="button" onClick={() => void store.load().catch(() => undefined)}>ลองใหม่</button></p>
    : null;

  if (route.kind === "player" && playerDivision && playerCard) {
    return (
      <>
        {freshnessNotice}
        <SpectatorParticipation
          card={playerCard}
          division={playerDivision}
          code={route.code}
          tournamentName={tournament.name}
          // A player link shared in a chat group opens with no history behind it, so Back would leave
          // the site entirely. Then the search — prefilled with the code that got them here — IS the
          // way back, and it replaces the entry rather than stacking a second one.
          onBack={() => pushedOwnEntry.current
            ? window.history.back()
            : navigate({ kind: "find", query: route.code, divisionId: null, school: null }, "replace")}
          onOpenPlayer={(divisionId, playerCode) => navigate({ kind: "player", divisionId, code: playerCode })}
          onBrowseDivision={() => {
            const saved = lastReportContext.current?.cardId === playerDivision.id ? lastReportContext.current.context : null;
            navigate({ kind: "card", cardId: playerDivision.id });
            if (saved) reportScroll.stage(playerDivision.id, saved.scrollY);
          }}
        />
      </>
    );
  }

  if (selectedCard) {
    return (
      <>
        {/* Keep the existing division back action visible in the isolated shell on every viewport. */}
        <button type="button" className="tour-card-back" onClick={() => navigate(SPECTATOR_HOME)} aria-label={`กลับไปเลือกรุ่นของ ${tournament.name}`}>
          <ArrowLeft size={18} aria-hidden="true" />
          <Trophy className="tour-card-back__trophy" size={19} aria-hidden="true" />
          <span className="tour-card-back__text"><span className="tour-card-back__prefix">รุ่นทั้งหมดของ </span>{tournament.name}</span>
        </button>
        {freshnessNotice}
        <CardOverviewView
          key={selectedCard.id}
          cardId={selectedCard.id}
          card={selectedCard}
          spectator
          initialSpectatorContext={reportContext}
          onSpectatorPlayer={(player, context) => openPlayerFromReport(selectedCard.id, player.id, context)}
        />
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

  const browse = tournamentCards.length === 0 ? (
    <EmptyState icon={<Trophy size={25} />} title="ยังไม่มีรุ่นการแข่งขัน" description="เมื่อผู้จัดเผยแพร่รุ่นการแข่งขัน รายการจะปรากฏที่นี่" />
  ) : (
    <section className="spectator-browse" aria-label="รายงานรายรุ่น">
      <h2 className="spectator-browse__title">รายงานรายรุ่น</h2>
      <div className="card-groups">
        {[...groupedCards.entries()].map(([name, group]) => (
          <section className="card-group" key={name}>
            {/* One group means the group's name is the tournament name the page header already
                carries — a second copy of it is noise, not structure. */}
            {groupedCards.size > 1 && <h3 className="card-group__title">{name}</h3>}
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
    </section>
  );

  return (
    <>
      {freshnessNotice}
      <PageHeader
        className="cards-page-header"
        title={tournament.name}
        description={published
          ? "การแข่งขันจบแล้ว — ค้นหานักกีฬาเพื่อดูผลที่ประกาศแล้ว"
          : "ค้นหานักกีฬาเพื่อดูคู่แข่งขัน ที่นั่ง และอันดับ"}
      />
      <SpectatorFind
        divisions={divisions}
        criteria={criteria}
        onCriteriaChange={changeCriteria}
        onOpenPlayer={openPlayer}
        onSubmit={submitSearch}
        browse={browse}
      />
    </>
  );
}
