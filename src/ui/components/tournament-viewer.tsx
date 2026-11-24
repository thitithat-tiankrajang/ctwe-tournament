"use client";

import { ArrowLeft, ChevronDown, ChevronRight, LockKeyhole, PowerOff, Search, Trophy } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createSpectatorState } from "@/application/tournament/spectator-state";
import { legacyPublicCard } from "@/application/tournament/spectator-read-model";
import { attemptReportScroll, createReportScrollOwner } from "@/application/tournament/spectator-report-scroll";
import { parseSpectatorHash, spectatorHash, spectatorReportContextFromHistory, SPECTATOR_HOME, type SpectatorReportContext, type SpectatorReportGame, type SpectatorReportView, type SpectatorRoute } from "@/application/tournament/spectator-route";
import { searchCoverageComplete, searchParticipants, searchReports, type SpectatorReportSearchHit, type SpectatorSearchCriteria, type SpectatorSearchResult } from "@/application/tournament/spectator-search";
import { fetchSystemState, systemIsOff, type SystemState } from "@/infrastructure/http/system-state";
import { useSpectatorSync } from "@/application/tournament/use-spectator-sync";
import { EmptyState } from "@/ui/components/page";
import { SpectatorParticipation } from "@/ui/components/spectator-participation";
import { browseGroups } from "@/ui/components/spectator-card-groups";
import { viewerCardStageInfo } from "@/ui/components/stage-info";
import { PrototypeViewerPopover } from "./prototype-spectator-chrome";
import { PrototypeSpectatorPlayer } from "./prototype-spectator-player";
import { sportThemeFor, useSportColorRevision } from "./sport-colors";
import { PrototypeSpectatorReport } from "./prototype-spectator-report";

const mobileViewport = "(max-width: 768px)";
const listenViewport = (listener: () => void) => {
  const query = window.matchMedia(mobileViewport);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
};

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
  const tournament = state.tournament;
  useSportColorRevision();
  const [dead, setDead] = useState(false);
  /** Set only when a failed load coincides with a declared system-off state (§20). */
  const [systemState, setSystemState] = useState<SystemState | null>(null);
  const [route, setRoute] = useState<SpectatorRoute>(currentRoute);
  const [searchOpen, setSearchOpen] = useState(false);
  const [reportOverlay, setReportOverlay] = useState<{ background: SpectatorRoute; context?: SpectatorReportContext } | null>(null);
  const playerAnchor = useRef<HTMLElement | null>(null);
  const profileFromSearch = useRef(false);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [bottom, setBottom] = useState<HTMLDivElement | null>(null);
  const mobile = useSyncExternalStore(listenViewport, () => window.matchMedia(mobileViewport).matches, () => false);
  const [reportRevision, setReportRevision] = useState(0);
  const [openReportDetails, setOpenReportDetails] = useState(false);
  const currentReport = useRef<{ game: SpectatorReportGame; views: SpectatorReportView[] }>({ game: null, views: [] });
  const rememberReportLens = useCallback((game: SpectatorReportGame, views: SpectatorReportView[]) => { currentReport.current = { game, views }; }, []);
  const [draftQuery, setDraftQuery] = useState(() => routeCriteria(currentRoute()).query);
  const searchRegion = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const searchForm = useRef<HTMLFormElement>(null);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [sportsClosed, setSportsClosed] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!searchOpen) return;
    searchInput.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !searchRegion.current?.contains(event.target)) setSearchOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [searchOpen]);
  /** Whether this visit has a history entry of its own to go back to (see `leavePlayer`). */
  const pushedOwnEntry = useRef(false);
  const reportScroll = useMemo(createReportScrollOwner, []);
  const pendingPlayerTop = useRef<string | null>(null);
  const lastReportContext = useRef<{ cardId: string; context: SpectatorReportContext } | null>(null);

  useEffect(() => {
    let active = true;
    const initial = currentRoute();
    setRoute(initial);
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
      setOpenReportDetails(false);
      if (next.kind === "find") setDraftQuery(next.query);
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
  /** The game each division's report shows (published semantics), so list badges never trail it. */
  const publishedGameById = useMemo(
    () => new Map(divisions.map((division) => [division.id, division.publication.currentGame])),
    [divisions],
  );
  const selectedCard = route.kind === "card" ? tournamentCards.find((card) => card.id === route.cardId) : undefined;
  const playerDivision = route.kind === "player" ? divisions.find((division) => division.id === route.divisionId) : undefined;
  const playerCard = playerDivision ? state.cards.find((card) => card.id === playerDivision.id) : undefined;
  const overlay = route.kind === "player" && playerCard && playerDivision ? reportOverlay : null;
  const background = overlay?.background ?? route;
  const backgroundCard = background.kind === "card" ? tournamentCards.find(card => card.id === background.cardId) : undefined;
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
    if (route.kind !== "card" || !selectedCard || !scroller) return;
    const target = reportScroll.targetFor(route.cardId);
    if (!target) return;
    const frame = window.requestAnimationFrame(() => {
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      // `scrollTo` is synchronous for behavior:auto. Clear only after the document reached the
      // requested position (or its current clamp when realtime made the report shorter).
      attemptReportScroll(
        reportScroll,
        target,
        maxScroll,
        (scrollY) => scroller.scrollTo({ top: scrollY, behavior: "auto" }),
        () => scroller.scrollTop,
      );
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [reportScroll, route, scroller, selectedCard?.id]);

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
    scroller?.scrollTo({ top: 0, behavior: "auto" });
  }, [route, scroller, playerCard?.id]);

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

  const navigateViewer = (next: SpectatorRoute, mode: "push" | "replace" = "push") => {
    setReportOverlay(null);
    setOpenReportDetails(false);
    navigate(next, mode);
    scroller?.scrollTo({ top: 0, behavior: "auto" });
  };
  const openPlayer = (divisionId: string, code: string, anchor?: HTMLElement | null, context?: SpectatorReportContext, master = false) => {
    if (selectedCard && context) rememberReportContext(selectedCard.id, context);
    playerAnchor.current = anchor ?? null;
    profileFromSearch.current = master;
    setReportOverlay({ background: route, context });
    setSearchOpen(false);
    navigate({ kind: "player", divisionId, code });
    pendingPlayerTop.current = null;
  };
  const closePlayer = () => {
    const trigger = playerAnchor.current;
    window.history.back();
    window.setTimeout(() => {
      if (trigger?.isConnected && !trigger.closest("[inert]")) trigger.focus({ preventScroll: true });
      else searchTrigger.current?.focus({ preventScroll: true });
    }, 80);
  };
  const openReportFromSearch = (hit: SpectatorReportSearchHit) => {
    setSearchOpen(false);
    const destination: SpectatorRoute = { kind: "card", cardId: hit.division.id };
    if (selectedCard?.id === hit.division.id) navigate(destination, "replace");
    else navigateViewer(destination);
    rememberReportContext(hit.division.id, {
      ...hit.context,
      filter: { ...hit.context.filter, query: draftQuery.trim() || (route.kind === "find" ? route.query : "") },
    });
    setOpenReportDetails(Boolean(hit.details));
    setReportRevision(revision => revision + 1);
  };

  type Hit = { sport: string; division: string; label: string; player: SpectatorSearchResult } | { sport: string; division: string; label: string; report: SpectatorReportSearchHit };
  const hits = (filters: SpectatorSearchCriteria, limit?: number): Hit[] => {
    const reportScope = filters.divisionId ? divisions.filter(division => division.id === filters.divisionId) : divisions;
    const nearby = selectedCard ? searchReports(reportScope.filter(division => division.id === selectedCard.id), filters.query, currentReport.current.game) : [];
    const reports = nearby.length ? nearby : searchReports(reportScope, filters.query);
    const scopedPlayers = searchParticipants(reportScope, filters, limit).results;
    return [
      ...reports.map(report => ({ report, sport: report.division.name, division: report.division.division, label: report.label })),
      ...scopedPlayers.flatMap(player => {
        const division = divisions.find(item => item.id === player.divisionId);
        return division ? [{ player, sport: division.name, division: player.divisionLabel, label: player.name }] : [];
      }),
    ];
  };
  const pick = (hit: Hit, anchor?: HTMLElement | null) => {
    if ("player" in hit) openPlayer(hit.player.divisionId, hit.player.code, anchor ?? searchTrigger.current, undefined, true);
    else openReportFromSearch(hit.report);
  };
  const draft = draftQuery.trim();
  const suggestions = searchOpen && draft ? hits({ ...EMPTY_CRITERIA, query: draft }, 20) : [];
  const hasSuggestions = searchOpen && Boolean(draft);
  const applied = background.kind === "find" ? background.query : reportContext?.filter.query || "";
  const searchLabel = draft || applied;
  const submitHeaderSearch = () => {
    setSearchOpen(false);
    if (!draft) {
      if (route.kind === "find") navigateViewer(SPECTATOR_HOME);
      return;
    }
    if (activeSuggestion >= 0 && suggestions[activeSuggestion]) {
      pick(suggestions[activeSuggestion]);
      return;
    }
    const outcome = searchParticipants(divisions, { ...EMPTY_CRITERIA, query: draft });
    const activeDivision = selectedCard ? divisions.find(item => item.id === selectedCard.id) : undefined;
    if (activeDivision) {
      const matchingPlayers = searchParticipants([activeDivision], { ...EMPTY_CRITERIA, query: draft }, activeDivision.participants.length).results;
      const report = searchReports([activeDivision], draft, currentReport.current.game)[0];
      if (report?.context.filter.playerIds.length) { openReportFromSearch(report); return; }
      if (matchingPlayers.length) {
        const { game, views } = currentReport.current;
        openReportFromSearch({
          division: activeDivision, label: draft,
          context: {
            game: game === "final" ? activeDivision.publication.publishedGames.at(-1) ?? null : game,
            views, scrollY: scroller?.scrollTop ?? 0,
            filter: { mode: "player", playerIds: matchingPlayers.map(player => player.code), schools: [], query: draft },
          },
        });
        return;
      }
      if (report) { openReportFromSearch(report); return; }
    }
    if (outcome.uniqueExactCode && searchCoverageComplete(divisions)) {
      const player = outcome.uniqueExactCode;
      openPlayer(player.divisionId, player.code, searchTrigger.current);
      return;
    }
    if (suggestions.length === 1 && "report" in suggestions[0]) {
      openReportFromSearch(suggestions[0].report);
      return;
    }
    navigateViewer({ kind: "find", ...EMPTY_CRITERIA, query: draft }, route.kind === "find" ? "replace" : "push");
  };
  const searchResults = (results: Hit[], query: string, popup: boolean) => {
    const groups = new Map<string, [Hit, number][]>();
    results.forEach((hit, index) => groups.set(hit.sport, [...(groups.get(hit.sport) ?? []), [hit, index]]));
    return <div className="lb vsearch-results" role={popup ? "listbox" : undefined} aria-label={popup ? "ผลการค้นหา" : undefined}>
      {groups.size === 0 ? <div className="lb__empty">ไม่พบ “{query}”</div> : [...groups].map(([sport, group]) =>
        <div className="vsearch-group sport-theme" key={sport} role={popup ? "group" : undefined} aria-label={sport} style={sportThemeFor(tournament?.id, sport)}>
          <div className="vsearch-group__head" aria-hidden>{sport}</div>
          {group.map(([hit, index]) => <button type="button" className="lb__opt vsearch-hit" key={index}
            id={popup ? `v-search-hit-${index}` : undefined} role={popup ? "option" : undefined} tabIndex={popup ? -1 : undefined}
            aria-selected={popup ? activeSuggestion === index : undefined} onClick={event => pick(hit, popup ? searchTrigger.current : event.currentTarget)}>
            {"player" in hit && <span className="code">{hit.player.code}</span>}
            <span className="vsearch-hit__text"><b>{hit.label}</b><small>{"player" in hit ? `${hit.player.school} · ${hit.division}` : hit.division}</small></span>
          </button>)}
        </div>)}
    </div>;
  };

  if (dead) {
    const off = systemIsOff(systemState);
    return <div className="panel"><EmptyState icon={off ? <PowerOff size={25} /> : <LockKeyhole size={25} />}
      title={off ? "ระบบจัดการแข่งขันปิดอยู่" : "ลิงก์นี้ใช้ไม่ได้"}
      description={off ? "ขณะนี้ไม่มีการจัดการแข่งขันอยู่ โปรดลองใหม่อีกครั้งภายหลัง" : "การแข่งขันนี้อาจยังไม่เปิดให้เข้าชม หรือถูกปิดไปแล้ว"}/></div>;
  }
  if (!tournament) return <div className="panel panel-padding">กำลังเข้าสู่การแข่งขัน…</div>;

  const theme = sportThemeFor(tournament?.id, backgroundCard?.name ?? "");
  const division = backgroundCard ? divisions.find(item => item.id === backgroundCard.id) : undefined;
  const groups = browseGroups(tournamentCards, tournament.name);
  const freshnessNotice = state.freshness === "reconnecting" || state.freshness === "delayed"
    ? <p className="spectator-freshness" role="status">การอัปเดตอาจล่าช้า — แสดงข้อมูลล่าสุดที่ได้รับ <button type="button" onClick={() => void store.load().catch(() => undefined)}>ลองใหม่</button></p>
    : null;

  return <div className="ctwe-prototype prototype-viewer-root">
    <div className={`app app--viewer ${mobile ? "app--mob" : "app--desk"}${backgroundCard ? " sport-theme" : ""}`}
      style={backgroundCard ? theme : undefined} inert={Boolean(overlay)}>
      <header className="vhead" id="vhead">
        <span id="vh-back">{background.kind !== "home" && <button type="button" className="icon-btn" aria-label="กลับไปหน้าก่อนหน้า"
          onClick={() => pushedOwnEntry.current ? window.history.back() : navigateViewer(SPECTATOR_HOME, "replace")}>
          <ArrowLeft className="i" size={20} /></button>}</span>
        <span className="vh-title" id="vh-title"><button type="button" className="vtour" aria-current={background.kind === "home" ? "page" : undefined}
          title="หน้าแรกของรายการแข่งขัน" onClick={() => { if (background.kind !== "home") navigateViewer(SPECTATOR_HOME); }}>
          <span className="brand-mark"><Trophy className="i" size={15} /></span>
          <span className="vtour__t">{backgroundCard && <small>{tournament.name}</small>}<span className="vtour__h">{backgroundCard ? `${backgroundCard.name} · ${backgroundCard.division}` : tournament.name}</span></span>
        </button></span>
        <span className="vhead__sp" />
        <div className="ms vsearch" id="v-search" data-open={searchOpen} ref={searchRegion} onKeyDown={event => {
          if (!searchOpen) return;
          if (event.key === "Escape") {
            event.preventDefault();
            setSearchOpen(false);
            requestAnimationFrame(() => searchTrigger.current?.focus({ preventScroll: true }));
            return;
          }
          if (!suggestions.length || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          const next = activeSuggestion < 0 ? (step === 1 ? 0 : suggestions.length - 1)
            : (activeSuggestion + step + suggestions.length) % suggestions.length;
          setActiveSuggestion(next);
          document.getElementById(`v-search-hit-${next}`)?.scrollIntoView({ block: "nearest" });
        }}>
          <button type="button" ref={searchTrigger} className={`ms__btn vsearch-btn${searchLabel ? " has-query" : ""}`}
            aria-controls="v-search-input" title={searchLabel} aria-expanded={searchOpen} inert={searchOpen}
            aria-label={!searchLabel ? "ค้นหา" : draft !== applied ? `คำค้นที่พิมพ์ไว้: ${searchLabel}` : `ค้นหาอยู่: ${searchLabel}`}
            onClick={() => { setActiveSuggestion(-1); setSearchOpen(true); }}>
            <Search className="i" size={18} /><span>{searchLabel}</span>
          </button>
          <form className="ms__field" id="v-search-form" ref={searchForm} inert={!searchOpen}
            onSubmit={event => { event.preventDefault(); submitHeaderSearch(); }}>
            <span className="ms__ico"><Search className="i" size={16} /></span>
            <input ref={searchInput} id="v-search-input" type="text" role="combobox" inputMode="search" enterKeyHint="search"
              aria-label="ค้นหาในรายการแข่งขัน" aria-autocomplete="list" aria-expanded={hasSuggestions}
              aria-controls={hasSuggestions ? "v-search-list" : undefined}
              aria-activedescendant={activeSuggestion >= 0 ? `v-search-hit-${activeSuggestion}` : undefined}
              autoComplete="off" value={draftQuery} placeholder="รหัส ชื่อ โรงเรียน รุ่น หรือเกม"
              onChange={event => { setDraftQuery(event.target.value); setActiveSuggestion(-1); }} />
            <button type="submit" className="vsearch-submit">ค้นหา</button>
          </form>
          {hasSuggestions && <PrototypeViewerPopover anchor={searchForm} kind="search" width={420} end label="ผลการค้นหา" style={backgroundCard ? theme : undefined}
            id="v-search-list" onDismiss={() => setSearchOpen(false)} keyboard={false}>
            {searchResults(suggestions, draft, true)}
          </PrototypeViewerPopover>}
        </div>
      </header>
      <div ref={setScroller} className="scroller" id="scroller"><div id="main-host">
        {freshnessNotice}
        {backgroundCard && division ? <PrototypeSpectatorReport key={`${backgroundCard.id}:${reportRevision}`}
          card={backgroundCard} division={division} mobile={mobile} theme={theme} bottom={bottom} scroller={scroller} onLens={rememberReportLens}
          initialContext={overlay?.context ?? reportContext} initiallyShowDetails={openReportDetails && reportContext?.cardId === backgroundCard.id}
          onPlayer={(player, target, context) => openPlayer(backgroundCard.id, player.id, target, context)} />
          : route.kind === "player" && playerDivision && playerCard && !overlay ? <div className="content">
            <SpectatorParticipation card={playerCard} division={playerDivision} code={route.code} tournamentName={tournament.name}
              onBack={() => pushedOwnEntry.current ? window.history.back()
                : navigateViewer({ kind: "find", query: route.code, divisionId: null, school: null }, "replace")}
              onOpenPlayer={(divisionId, code) => navigateViewer({ kind: "player", divisionId, code })}
              onBrowseDivision={() => {
                const saved = lastReportContext.current?.cardId === playerDivision.id ? lastReportContext.current.context : null;
                navigateViewer({ kind: "card", cardId: playerDivision.id });
                if (saved) reportScroll.stage(playerDivision.id, saved.scrollY);
              }} />
          </div> : <div className="content viewer-home">
            {background.kind === "find" && background.query && <section className="panel vsearch-applied" aria-label="ผลการค้นหา">
              <div className="panel-head"><h2>ผลการค้นหา “{background.query}”</h2></div>
              {searchResults(hits(routeCriteria(background)), background.query, false)}
            </section>}
            <section className="lobby-directory" aria-label="กีฬาและรุ่นการแข่งขัน"><div className="sport-groups">
              {groups.map(({ name, cards: group }) => {
                const open = !sportsClosed.has(name);
                const id = `sport-${group[0].id}`;
                return <section className="sport-group sport-theme" key={name} style={sportThemeFor(tournament?.id, name)}>
                  <h2><button className="sport-group__head" type="button" aria-expanded={open} aria-controls={id}
                    onClick={() => setSportsClosed(previous => {
                      const next = new Set(previous);
                      if (next.has(name)) next.delete(name); else next.add(name);
                      return next;
                    })}>
                    <span className="sport-letter" aria-hidden>{name.slice(0, 1)}</span><span className="sport-heading"><span className="sport-name">{name}</span><small>{group.length} รุ่น</small></span>
                    <span className="sport-chevron"><ChevronDown className="i" size={17} /></span>
                  </button></h2>
                  <div className="sport-fold" id={id} inert={!open}><div>
                    {group.map(card => {
                      const publication = divisions.find(item => item.id === card.id)?.publication;
                      const stage = viewerCardStageInfo(card, publishedGameById.get(card.id));
                      const game = publication?.currentGame ?? card.currentGame;
                      const status = card.status === "CLOSED" ? ["closed", "ปิดการ์ดแล้ว"]
                        : publication?.phase === "complete" ? ["done", "จบการแข่งขันแล้ว"]
                        : publication?.phase === "finals" ? ["final", "รอบชิงชนะเลิศ"]
                        : publication?.phase === "registration" ? ["idle", "ยังไม่เริ่ม"]
                        : ["live", publication?.pairingAvailable ? `กำลังแข่ง · เกม ${game}` : `รอประกาศคู่ · เกม ${game}`];
                      return <button type="button" className="vrow vrow--div" key={card.id} onClick={() => navigateViewer({ kind: "card", cardId: card.id })}>
                        <span className="vrow__main">{card.division}</span><span className="lobby-state" data-state={status[0]} title={stage.label}><i aria-hidden />{status[1]}</span>
                        <ChevronRight className="i vrow__chev" size={15} />
                      </button>;
                    })}
                  </div></div>
                </section>;
              })}
            </div></section>
            {tournamentCards.length === 0 && <div className="notice notice--quiet"><p>ยังไม่มีรุ่นการแข่งขันที่เผยแพร่</p></div>}
          </div>}
      </div></div>
      <div ref={setBottom} id="vbottom" />
    </div>
    {overlay && route.kind === "player" && playerDivision && playerCard && <PrototypeSpectatorPlayer card={playerCard}
      division={playerDivision} code={route.code} theme={sportThemeFor(tournament?.id, playerCard.name)} mobile={mobile} anchor={playerAnchor} master={profileFromSearch.current}
      onClose={closePlayer} onOpenPlayer={code => navigate({ kind: "player", divisionId: playerDivision.id, code }, "replace")} />}
  </div>;
}
