"use client";

import { isSpectatorRoute } from "@/application/tournament/spectator-route";
import { publicDivisionPayload, spectatorDivision } from "@/application/tournament/spectator-read-model";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { Activity, ArrowRight, ChevronDown, ChevronRight, Code2, Eye, FileClock, Folder, FolderOpen, Gamepad2, Layers, LogOut, Menu, PanelLeft, Search, ShieldCheck, TableProperties, Trophy, UserCog, Users, X, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { isAuthPending, selectAuthStatus } from "@/application/tournament/auth-status";
import { readActiveTournament, selectCardList, useTournamentStore, type CardListRow } from "@/application/tournament/store";
import { useCardSync } from "@/application/tournament/use-card-sync";
import { useFullCard } from "@/application/tournament/use-full-card";
import { usePublicSync } from "@/application/tournament/use-public-sync";
import { useCardWakeReconciliation } from "@/application/tournament/use-card-wake-reconciliation";
import { matchesPlayerCode, parseSearchQuery } from "@/domain/tournament/player-code";
import { hasStaffAccess, isAdmin, isDirector, isOperator } from "@/domain/tournament/roles";
import type { RuntimeStage, Tournament } from "@/domain/tournament/types";
import { toast } from "@/application/ui/toast";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { Toaster } from "@/ui/components/toaster";
import { GlobalDialogHost } from "@/ui/components/global-dialog-host";
import { CardWakeReconciliationNotice } from "@/ui/components/card-wake-reconciliation-notice";
import { SpectatorParticipation } from "@/ui/components/spectator-participation";
import { operatorStageLabels } from "@/ui/components/stage-info";
import { PrototypeViewerHelp } from "@/ui/components/prototype-spectator-chrome";
import { useModalDialog } from "@/ui/overlay/use-modal-dialog";

const EXPANDED_KEY = "ctwe.sidebarLocked";
const MOBILE_QUERY = "(max-width: 768px)";

function subscribeViewport(callback: () => void) {
  const media = window.matchMedia(MOBILE_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

function stageHref(id: string, stage: RuntimeStage) {
  switch (stage) {
    case "PLAYER_REGISTRATION": return `/cards/${id}/players`;
    case "TABLE_PAIRING":
    case "PAIRING_PREVIEW": return `/cards/${id}/tables`;
    case "RESULT_COLLECTION":
    case "RESULT_REVIEW":
    case "FINAL_SEEDING":
    case "FINAL_COLLECTION": return `/cards/${id}/games`;
    default: return `/cards/${id}`;
  }
}

type NavEntry = { href: string; label: string; icon: LucideIcon };
type ShellCard = Pick<CardListRow, "id" | "tournamentId" | "name" | "division" | "status" | "runtimeStage" | "currentGame" | "gameCount" | "playerCount" | "createdAt">;

const shellCardView = ({ id, tournamentId, name, division, status, runtimeStage, currentGame, gameCount, playerCount, createdAt }: CardListRow): ShellCard =>
  ({ id, tournamentId, name, division, status, runtimeStage, currentGame, gameCount, playerCount, createdAt });

function cardLinks(id: string, operator: boolean, director: boolean, admin: boolean): NavEntry[] {
  return [
    { href: `/cards/${id}`, label: admin ? "ภาพรวมการแข่งขัน" : "ภาพรวม", icon: Activity },
    ...(director ? [
      { href: `/cards/${id}/players`, label: "ผู้เล่น", icon: Users },
      { href: `/cards/${id}/tables`, label: "โต๊ะแข่งขัน", icon: TableProperties },
    ] : []),
    ...(operator ? [{ href: `/cards/${id}/games`, label: "ผลการแข่งขัน", icon: Gamepad2 }] : []),
    ...(director || admin ? [{ href: `/cards/${id}/audit`, label: "บันทึกกิจกรรม", icon: FileClock }] : []),
  ];
}

function cardStatus(card: ShellCard) {
  if (card.status === "CLOSED") return ["closed", "ปิดการ์ดแล้ว", "ปิดแล้ว"];
  if (card.status === "FINISHED" || card.runtimeStage === "FINAL_PUBLISHED") return ["done", "จบการแข่งขันแล้ว", "จบแล้ว"];
  if (card.runtimeStage.startsWith("FINAL")) return ["final", "รอบชิงชนะเลิศ", "รอบชิง"];
  if (card.runtimeStage === "PLAYER_REGISTRATION") return ["idle", "ยังไม่เริ่ม", `ลงทะเบียน ${card.playerCount}`];
  return ["live", "กำลังแข่งขัน", `เกม ${card.currentGame}/${card.gameCount}`];
}

/** Top-bar status for a card page: status text, plus the operational step while games run. */
function cardStatusLine(card: ShellCard) {
  const [status, text] = cardStatus(card);
  return status === "live" ? `${text} · ${operatorStageLabels[card.runtimeStage]}` : text;
}

/** Sports in the order their first division was created; divisions in creation order. */
function byCreation(left: { createdAt: string }, right: { createdAt: string }) {
  return left.createdAt.localeCompare(right.createdAt);
}

const icon = (Icon: LucideIcon, size = 18) => <Icon size={size} className="i" aria-hidden />;
const mark = <span className="brand-mark">{icon(Trophy, 16)}</span>;
const fold = <span className="fold" aria-hidden><Folder className="i f-closed" size={16} /><FolderOpen className="i f-open" size={16} /></span>;

function RailLink({ item, current, onNavigate, ariaLabel }: { item: NavEntry; current?: boolean; onNavigate?: () => void; ariaLabel?: string }) {
  return <Link prefetch={false} scroll={false} href={item.href} className="rail__i rail-action" aria-label={ariaLabel ?? item.label} title={ariaLabel ?? item.label}
    aria-current={current ? "page" : undefined} onClick={onNavigate}>
    <span className="rail-icon">{icon(item.icon)}</span>
    <span className="rail-label" aria-hidden>{item.label}</span>
  </Link>;
}

function PageLink({ item, path, next, onNavigate }: { item: NavEntry; path: string; next?: string; onNavigate?: () => void }) {
  return <Link prefetch={false} scroll={false} href={item.href} className="nav-link" aria-current={item.href === path ? "page" : undefined} onClick={onNavigate}>
    {icon(item.icon, 15)}<span>{item.label}</span>
    <span className="next-flag" hidden={item.href !== next || item.href === path}>ทำต่อ{icon(ArrowRight, 11)}</span>
  </Link>;
}
/**
 * Hosts the live-sync hooks so their store subscriptions re-render **nothing**.
 *
 * `use-card-sync.ts` subscribes to the open card's `version`, which increments on every result
 * patch, and `use-public-sync.ts` subscribes to the whole `cards` array. Called directly from
 * `AppShell`, either one re-rendered the entire shell — sidebar, nav, mobile chrome — once per SSE
 * result event during live scoring. Measured: exactly 1 shell render per event.
 *
 * Both hooks are frozen (`03_INVARIANTS.md` §1), so the caller moves instead of the hook. The
 * subscriptions now sit in a component that renders `null`, and its props are primitives, so it
 * re-renders only when the open card or the viewer's role actually changes.
 */
function CardSyncHost({ cardId, isStaff, loading }: { cardId?: string; isStaff: boolean; loading: boolean }) {
  // Live multi-user sync is a back-office concern; public viewers receive published snapshots only.
  // Both are held until the initial `load()` settles: until then `auth` is still anonymous, so a
  // staff member would briefly be treated as a viewer and open the PUBLIC stream, only to tear it
  // down and open the staff one a moment later. Gating on `!loading` is the exception
  // `03_INVARIANTS.md` §1 pre-agreed for P2; neither hook's own code is touched.
  useCardSync(!loading && isStaff ? cardId : undefined);
  usePublicSync(loading ? undefined : cardId, !isStaff);
  // P3-B: the authenticated list is summaries now, so an opened card must be fetched in full once.
  useFullCard(cardId, !loading && isStaff);
  useCardWakeReconciliation(cardId, !loading && isStaff);
  return null;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isSpectatorRoute(pathname)) return (
    <div className="ctwe-prototype app-shell spectator-shell"><div className="app-main app-main--standalone-overview">
      <main className="content">{children}</main>
    </div><Toaster /><GlobalDialogHost appearance="prototype" /></div>
  );
  return <OperationalShell>{children}</OperationalShell>;
}

function OperationalShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const id = typeof params.id === "string" ? params.id : undefined;
  const mobile = useSyncExternalStore(subscribeViewport, () => window.matchMedia(MOBILE_QUERY).matches, () => false);
  const auth = useTournamentStore((state) => state.auth);
  const loading = useTournamentStore((state) => state.loading);
  // Keep score and version patches from re-rendering the navigation tree.
  const cardSignature = useTournamentStore((state) => JSON.stringify(selectCardList(state.cards, state.summaries).map(shellCardView)));
  const shellCards = useMemo(() => JSON.parse(cardSignature) as ShellCard[], [cardSignature]);
  const activeTournament = useTournamentStore((state) => state.activeTournament);
  const setActiveTournament = useTournamentStore((state) => state.setActiveTournament);
  const loadTournaments = useTournamentStore((state) => state.loadTournaments);
  const logout = useTournamentStore((state) => state.logout);
  const [pinned, setPinned] = useState(false);
  const [peek, setPeek] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState<false | "rail" | "sheet">(false);
  const [loadedTournaments, setLoadedTournaments] = useState<{ username: string | null; choices: Tournament[] } | null>(null);
  const [switchStatus, setSwitchStatus] = useState<"idle" | "loading" | "error">("idle");
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [folders, setFolders] = useState<Set<string>>(() => new Set());
  const [sports, setSports] = useState<Map<string, boolean>>(() => new Map());
  const hoverTimer = useRef<number | undefined>(undefined);
  const sidebar = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLElement>(null);
  const switchTrigger = useRef<HTMLButtonElement>(null);
  const switchMenu = useRef<HTMLDivElement>(null);
  const crumbs = useRef<HTMLDetailsElement>(null);
  const sheet = useModalDialog({ open: mobile && sheetOpen, onDismiss: () => setSheetOpen(false) });
  const isStaff = hasStaffAccess(auth);
  const admin = isAdmin(auth);
  const director = isDirector(auth);
  const operator = isOperator(auth);
  const authPending = isAuthPending(selectAuthStatus({ loading, auth }));
  const currentCard = id ? shellCards.find((card) => card.id === id) : undefined;
  // Admin's rail keeps the last opened card's pages on every page, as in the accepted design.
  const [lastCardId, setLastCardId] = useState<string | undefined>(undefined);
  useEffect(() => { if (currentCard) setLastCardId(currentCard.id); }, [currentCard]);
  const railCard = currentCard ?? (lastCardId ? shellCards.find((card) => card.id === lastCardId) : undefined);
  const railPrefix = useTournamentStore((state) => railCard ? state.cards.find((card) => card.id === railCard.id)?.codePrefix : undefined);
  const tournamentId = currentCard?.tournamentId ?? activeTournament?.id;
  const tourName = activeTournament?.id === tournamentId ? activeTournament?.name : loadedTournaments?.choices.find((tour) => tour.id === tournamentId)?.name;
  const tournamentTitle = tourName ?? (tournamentId ? "" : "เลือกรายการแข่งขัน");
  const pages = currentCard ? cardLinks(currentCard.id, operator, director, admin) : [];
  const railPages = railCard ? cardLinks(railCard.id, operator, director, admin) : [];
  const shortcuts: NavEntry[] = isStaff ? [
    { href: tournamentId ? "/cards" : "/", label: "รายการแข่งขันทั้งหมด", icon: Layers },
    ...(director ? [{ href: "/director", label: "คอนโซลผู้อำนวยการ", icon: UserCog }] : []),
    ...(admin ? [
      { href: "/admin", label: "ผู้ดูแลระบบ", icon: ShieldCheck },
      { href: "/dev-tools", label: "เครื่องมือนักพัฒนา", icon: Code2 },
    ] : []),
  ] : [];
  const allLinks = [...shortcuts, ...pages];
  const activePage = (currentCard && pathname === `/cards/${currentCard.id}` ? "ภาพรวม" : undefined) ?? allLinks.find((link) => link.href === pathname)?.label ??
    (pathname === "/staff-login" ? "เข้าสู่ระบบ" : pages[0]?.label ?? "รายการแข่งขันทั้งหมด");
  const workflow = currentCard && operator ? stageHref(currentCard.id, currentCard.runtimeStage) : undefined;
  const open = pinned || peek;
  const previousFlowRef = useRef<{ cardId?: string; stage?: RuntimeStage }>({ cardId: id, stage: currentCard?.runtimeStage });

  useEffect(() => {
    try { setPinned(sessionStorage.getItem(EXPANDED_KEY) === "1"); } catch { /* unavailable */ }
    setActiveTournament(readActiveTournament());
    setHydrated(true);
    return () => window.clearTimeout(hoverTimer.current);
  }, [setActiveTournament]);
  useEffect(() => { if (hydrated) try { sessionStorage.setItem(EXPANDED_KEY, pinned ? "1" : "0"); } catch { /* unavailable */ } }, [hydrated, pinned]);

  // A card opened from a direct link knows its tournament id but not its name: resolve the name
  // from the operator's own tournament list and make that tournament the active one.
  const resolving = useRef<string | null>(null);
  useEffect(() => {
    if (!hydrated || loading || !isStaff || !tournamentId || tourName || resolving.current === tournamentId) return;
    resolving.current = tournamentId;
    void loadTournaments().then((list) => {
      setLoadedTournaments({ username: auth.username, choices: list });
      const match = list.find((tour) => tour.id === tournamentId);
      if (match && useTournamentStore.getState().activeTournament?.id !== match.id) setActiveTournament({ id: match.id, name: match.name });
    }, () => { resolving.current = null; });
  }, [auth.username, hydrated, isStaff, loadTournaments, loading, setActiveTournament, tourName, tournamentId]);

  // Visiting a division opens its folder without closing folders the operator expanded.
  useEffect(() => {
    if (!id) return;
    setFolders((prior) => prior.has(id) ? prior : new Set(prior).add(id));
  }, [id]);
  // The accepted design fades each newly opened page in (3px rise); in-place refreshes do not animate.
  useEffect(() => {
    const element = content.current;
    if (!element) return;
    element.classList.remove("page-enter");
    void element.offsetWidth;
    element.classList.add("page-enter");
  }, [pathname]);
  useEffect(() => {
    if (crumbs.current) crumbs.current.open = false;
    setSheetOpen(false);
    setSwitchOpen(false);
    const anchor = window.location.hash.slice(1);
    const target = anchor.startsWith("sport-") ? document.getElementById(anchor) : null;
    if (target) target.scrollIntoView({ block: "start" });
    else if (scroll.current) scroll.current.scrollTop = 0;
  }, [pathname]);
  useEffect(() => {
    const details = crumbs.current;
    if (!details) return;
    const outside = (event: PointerEvent) => {
      if (details.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [id, mobile]);
  useEffect(() => {
    if (mobile) return;
    setSheetOpen(false);
  }, [mobile]);
  useEffect(() => {
    if (!switchOpen) return;
    const first = switchMenu.current?.querySelector<HTMLButtonElement>('button[aria-current="true"],button');
    first?.focus({ preventScroll: true });
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (switchMenu.current?.contains(event.target) || switchTrigger.current?.contains(event.target)) return;
      setSwitchOpen(false);
      if (!pinned && !sidebar.current?.matches(":hover")) setPeek(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [switchOpen, pinned]);

  // Preserve automatic follow for a live stage transition while the user is on its old step.
  useEffect(() => {
    const nextStage = currentCard?.runtimeStage;
    const previous = previousFlowRef.current;
    previousFlowRef.current = { cardId: id, stage: nextStage };
    if (previous.cardId !== id) return;
    const previousStage = previous.stage;
    if (!operator || !id || !previousStage || !nextStage || previousStage === nextStage) return;
    if (pathname === stageHref(id, previousStage)) router.replace(stageHref(id, nextStage));
  }, [currentCard?.runtimeStage, id, operator, pathname, router]);

  const sportGroups = useMemo(() => {
    const grouped = new Map<string, ShellCard[]>();
    for (const card of [...shellCards].sort(byCreation)) {
      if (card.tournamentId !== tournamentId) continue;
      const group = grouped.get(card.name) ?? [];
      group.push(card);
      grouped.set(card.name, group);
    }
    return [...grouped];
  }, [shellCards, tournamentId]);

  const choices = loadedTournaments?.username === auth.username ? loadedTournaments?.choices ?? [] : [];
  const tourHref = tournamentId ? "/cards" : "/";
  const roleLabel = admin ? "ADMIN · ผู้ดูแลระบบ" : director ? "DIRECTOR · ผู้อำนวยการ" : "STAFF · เจ้าหน้าที่กรอกผล";
  const pinLabel = pinned ? "เลิกตรึงแถบเมนู" : "ตรึงแถบเมนูให้เปิดค้าง";

  const schedulePeek = (opening: boolean) => {
    if (pinned) return;
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      if (!opening && (sidebar.current?.matches(":hover") || sidebar.current?.querySelector(":focus-visible") || switchOpen === "rail")) return;
      setPeek(opening);
    }, opening ? 60 : 220);
  };

  const openSwitcher = (source: "rail" | "sheet") => {
    if (switchOpen === source) { setSwitchOpen(false); return; }
    window.clearTimeout(hoverTimer.current);
    if (source === "rail") setPeek(true);
    setSwitchOpen(source);
    setSwitchStatus("loading");
    void loadTournaments().then((result) => {
      setLoadedTournaments({ username: auth.username, choices: result });
      setSwitchStatus("idle");
    }, () => setSwitchStatus("error"));
  };

  const switchTournament = (tour?: { id: string; name: string }) => {
    setActiveTournament(tour ? { id: tour.id, name: tour.name } : null);
    if (tour?.id !== tournamentId) {
      setSports(new Map());
      setFolders(new Set());
    }
    setSwitchOpen(false);
    setSheetOpen(false);
    router.push(tour ? "/cards" : "/");
  };

  const menu = <div className="tmenu" role="group" aria-label="เปลี่ยนรายการแข่งขัน" ref={switchMenu}
    onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSwitchOpen(false);
      switchTrigger.current?.focus({ preventScroll: true });
    }}>
    {choices.map((tour) => <button key={tour.id} type="button" aria-current={tour.id === tournamentId ? "true" : undefined}
      onClick={() => switchTournament(tour)}>{icon(Trophy, 14)}{tour.name}</button>)}
    {choices.length === 0 && tourName && tournamentId && <button type="button" aria-current="true" onClick={() => switchTournament({ id: tournamentId, name: tourName })}>{icon(Trophy, 14)}{tourName}</button>}
    <button type="button" onClick={() => switchTournament()}>{icon(Layers, 14)}เลือกรายการแข่งขันทั้งหมด</button>
    {switchStatus !== "idle" && <span className="meta" role="status">{switchStatus === "loading" ? "กำลังโหลด…" : "โหลดรายการแข่งขันไม่สำเร็จ"}</span>}
  </div>;

  const renderTree = (mobileTree = false) => <div className="tree">
    {sportGroups.map(([sport, cards]) => {
      const sportOpen = sports.get(sport) ?? cards.some((card) => card.id === id);
      return <div className="tnode" key={sport} data-open={sportOpen}>
        <button type="button" className="trow trow--sport" aria-expanded={sportOpen}
          onClick={() => setSports((previous) => new Map(previous).set(sport, !sportOpen))}>
          <ChevronRight className="i chev" size={13} aria-hidden />{fold}<span className="tlabel">{sport}</span><span className="tcount">{cards.length}</span>
        </button>
        <div className="tkids" inert={!sportOpen}><div className="tkids-in">
          {cards.map((card) => {
            const expanded = folders.has(card.id);
            const [status, statusText, shortStage] = cardStatus(card);
            return <div className="tnode" key={card.id} data-open={expanded}>
              <button type="button" className="trow trow--div" aria-expanded={expanded} aria-current={card.id === id}
                data-status={status} onClick={() => setFolders((prior) => {
                  const next = new Set(prior);
                  if (next.has(card.id)) next.delete(card.id); else next.add(card.id);
                  return next;
                })}>
                <span className={`strip strip--${status}`} aria-hidden /><ChevronRight className="i chev" size={13} aria-hidden />
                {fold}<span className="tlabel">{card.division || card.name}</span><span className="div-chip">{shortStage}</span><span className="sr">สถานะ {statusText}</span>
              </button>
              <div className="tkids" inert={!expanded}><div className="tkids-in tkids-in--pages">
                {cardLinks(card.id, operator, director, admin).map((item) => <PageLink key={item.href} item={item} path={pathname}
                  next={operator ? stageHref(card.id, card.runtimeStage) : undefined} onNavigate={mobileTree ? () => setSheetOpen(false) : undefined} />)}
              </div></div>
            </div>;
          })}
        </div></div>
      </div>;
    })}
  </div>;

  const confirmLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
      setLogoutConfirm(false);
      router.replace("/");
      router.refresh();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "ออกจากระบบไม่สำเร็จ");
    } finally {
      setLoggingOut(false);
    }
  };

  const switchable = director || admin;
  const navItems = currentCard ? pages : shortcuts;
  const showTopStat = Boolean(currentCard) && !director && !(operator && pathname.endsWith("/games"));
  const readOnlyTag = admin && currentCard ? <>
    <span className="meta-tag">{icon(Eye, 13)}ดูอย่างเดียว</span>
    <PrototypeViewerHelp label="ดูอย่างเดียว">ผู้ดูแลระบบดูการ์ดได้ทุกรายการแต่ไม่แก้ไขการแข่งขัน งานของผู้ดูแลอยู่ในคอนโซลผู้ดูแลระบบ</PrototypeViewerHelp>
  </> : null;
  return (
    <div className="ctwe-prototype proto-workspace">
      <div className={`app app--op ${mobile ? "app--mob" : "app--desk"}${pinned ? " side-pinned" : ""}`} id="opapp">
        <CardSyncHost cardId={id} isStaff={isStaff} loading={loading} />
        {isStaff && <aside className="sidebar" id="sidebar" ref={sidebar} data-open={open} hidden={mobile}
          aria-label="เมนูหลัก" onPointerEnter={(event) => { if (event.pointerType === "mouse") schedulePeek(true); }}
          onPointerLeave={(event) => { if (event.pointerType === "mouse") schedulePeek(false); }}
          onFocusCapture={(event) => { if (event.target.matches(":focus-visible:not(.rail__toggle)")) { window.clearTimeout(hoverTimer.current); setPeek(true); } }}
          onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) schedulePeek(false); }}>
          <div className="side-panel">
            <nav className={`rail${operator ? " rail--operator" : ""}`} aria-label="เมนูหลัก">
              <header className="rail-header">
                <div className="side-head">
                  {director ? <button ref={switchOpen !== "sheet" ? switchTrigger : undefined} type="button"
                    className="rail__i rail-action tswitch-btn director-tour-trigger" aria-expanded={switchOpen === "rail"}
                    aria-label={`เปลี่ยนรายการแข่งขัน · ${tournamentTitle}`} title={tournamentTitle}
                    onClick={() => openSwitcher("rail")}>
                    <span className="rail-icon">{mark}</span><span className="rail-label director-tour-name" aria-hidden>{tournamentTitle}</span>
                    <span className="rail-label director-tour-arrows" aria-hidden>{icon(ChevronDown, 12)}{icon(ChevronDown, 12)}</span>
                  </button> : admin ? <>
                    <Link prefetch={false} scroll={false} href={tourHref} className="rail__i rail-action tlink"
                      aria-label={`${tournamentTitle} · การ์ดทั้งหมด`} title="การ์ดทั้งหมด">
                      <span className="rail-icon">{mark}</span>
                      <span className="rail-label rail-tournament" aria-hidden><strong>{tournamentTitle}</strong><small>การ์ดทั้งหมด</small></span>
                    </Link>
                    <button ref={switchOpen !== "sheet" ? switchTrigger : undefined} type="button" className="tswitch-btn rail-label"
                      aria-haspopup="menu" aria-expanded={switchOpen === "rail"} aria-label="เปลี่ยนรายการแข่งขัน" title="เปลี่ยนรายการแข่งขัน"
                      onClick={() => openSwitcher("rail")}>{icon(ChevronDown, 15)}</button>
                  </> : <div className="rail-tour-static" title={tournamentTitle}>
                    <span className="rail-icon">{mark}</span><span className="rail-label director-tour-name">{tournamentTitle}</span>
                  </div>}
                  {switchOpen === "rail" && menu}
                </div>
                {admin && <button type="button" className="rail__i rail-action rail__toggle" aria-controls="side-nav" aria-expanded={open}
                  aria-label={open ? "ย่อเมนู" : "ขยายเมนู"} disabled={pinned} onClick={() => setPeek((value) => !value)}>
                  <span className="rail-icon">{icon(Menu)}</span><span className="rail-label" aria-hidden>{open ? "ย่อเมนู" : "ขยายเมนู"}</span>
                </button>}
              </header>
              <div className="rail-body">
                <div className="rail-shortcuts">
                  {shortcuts.map((item) => <RailLink key={item.href} item={item} current={item.href === pathname} />)}
                  {admin && railCard && <>
                    <div className="rail-card-heading" title={`${railCard.name} · ${railCard.division}`}>
                      <span className="rail-icon">{railPrefix ? <span className="rail__cap">{railPrefix}</span> : icon(Folder, 15)}</span>
                      <span className="rail-label" aria-hidden>{railCard.name} · {railCard.division}</span></div>
                    {railPages.map((item) => <RailLink key={item.href} item={item} ariaLabel={`${railCard.division} · ${item.label}`}
                      current={item.href === pathname} />)}
                  </>}
                </div>
                <div className="rail-browse rail-label" id="side-nav" inert={!open}>
                  {admin && <p className="nav-label">กีฬาและรุ่น</p>}
                  {renderTree()}
                </div>
              </div>
              <footer className="rail-footer">
                <button type="button" className="rail__i rail-action" aria-label="ออกจากระบบ" title="ออกจากระบบ" onClick={() => setLogoutConfirm(true)}>
                  <span className="rail-icon">{icon(LogOut)}</span><span className="rail-label rail-account" aria-hidden>
                    <strong>ออกจากระบบ</strong><small>{auth.username} · {roleLabel}</small>
                  </span>
                </button>
                <button type="button" className="rail__i rail-action pin2" aria-pressed={pinned} aria-label={pinLabel} title={pinLabel}
                  onClick={() => {
                    window.clearTimeout(hoverTimer.current);
                    setPeek(Boolean(sidebar.current?.matches(":hover")));
                    setPinned((value) => !value);
                  }}>
                  <span className="rail-icon">{icon(PanelLeft)}</span><span className="rail-label" aria-hidden>{pinned ? "เลิกตรึงเมนู" : "ตรึงเมนู"}</span>
                </button>
              </footer>
            </nav>
          </div>
        </aside>}
        <div className="main">
          <header className="topbar">
            {mobile ? isStaff ? <>
              <button type="button" className="icon-btn" aria-label="เมนูและรุ่นการแข่งขัน" aria-haspopup="dialog" onClick={() => setSheetOpen(true)}>{icon(Menu, 22)}</button>
              <button type="button" className="mtitle" aria-haspopup="dialog" aria-expanded={sheetOpen} onClick={() => setSheetOpen(true)}>
                <small>{currentCard ? `${currentCard.name} · ${activePage}` : tournamentTitle}</small>
                <strong>{currentCard?.division ?? activePage}{icon(ChevronDown, 15)}</strong>
              </button>
            </> : <strong>{authPending ? "กำลังตรวจสอบสิทธิ์…" : activePage}</strong> : (
              <nav className="crumbs" aria-label="ตำแหน่ง">
                {currentCard && isStaff && <>
                  <Link prefetch={false} scroll={false} className="crumb-link" href="/cards">{tournamentTitle}</Link>{icon(ChevronRight, 13)}
                  <Link prefetch={false} scroll={false} className="crumb-link" href={`/cards#sport-${encodeURIComponent(currentCard.name)}`}>{currentCard.name}</Link>{icon(ChevronRight, 13)}
                  <details ref={crumbs} className="prototype-crumb-dropdown" onKeyDown={(event) => {
                    if (event.key !== "Escape" || !event.currentTarget.open) return;
                    event.preventDefault();
                    event.currentTarget.open = false;
                    event.currentTarget.querySelector("summary")?.focus();
                  }}>
                    <summary className="crumb-link crumb-stage">{currentCard.division}{icon(ChevronDown, 12)}</summary>
                    <div className="pop crumb-stage-menu">
                      <h2>{currentCard.division}</h2>
                      {pages.map((item) => <Link key={item.href} prefetch={false} scroll={false} href={item.href}
                        aria-current={item.href === pathname ? "page" : undefined} onClick={() => { if (crumbs.current) crumbs.current.open = false; }}>
                        {icon(item.icon, 15)}<span>{item.label}</span>{item.href === workflow && <small>ทำต่อ</small>}
                      </Link>)}
                    </div>
                  </details>{icon(ChevronRight, 13)}
                </>}
                <strong aria-current="page">{authPending ? "กำลังตรวจสอบสิทธิ์…" : activePage}</strong>
              </nav>
            )}
            {mobile && isStaff && (readOnlyTag ?? (showTopStat && currentCard && <span className="topstat topstat--mob">
              <span className={`strip strip--${cardStatus(currentCard)[0]}`} /><span className="count">{cardStatus(currentCard)[2]}</span>
              <span className="sr">{cardStatus(currentCard)[1]}</span>
            </span>))}
            {!mobile && <><span className="spacer" />
              <span className="topchip">
                {showTopStat && currentCard && <span className="topstat">
                  <span className={`strip strip--${cardStatus(currentCard)[0]}`} /><span>{cardStatusLine(currentCard)}</span>
                  <span className="count">{cardStatus(currentCard)[2]}</span>
                </span>}
                {readOnlyTag}
              </span>
            </>}
            {isStaff && <OperatorSearch tournamentId={tournamentId} tournamentName={tourName} cardId={id} cardKeys={sportGroups.flatMap(([, cards]) => cards.map((card) => card.id))} />}
          </header>
          <div className="scroller" ref={scroll}>
            <CardWakeReconciliationNotice cardId={isStaff ? id : undefined} />
            <main className="content" ref={content}>{children}</main>
          </div>
          <nav className="mobile-nav" aria-label="เมนูมือถือ" hidden={!mobile || navItems.length < 2}>
            {navItems.map((item) => <button type="button" key={item.href} aria-current={item.href === pathname ? "page" : undefined}
              aria-label={`${item.label}${item.href === workflow && item.href !== pathname ? " (ทำต่อ)" : ""}`} onClick={() => router.push(item.href, { scroll: false })}>
              {item.href === workflow && item.href !== pathname && <span className="dot-next" aria-hidden />}
              {icon(item.icon, 19)}<span aria-hidden>{item.label}</span>
            </button>)}
          </nav>
        </div>
        {mobile && sheetOpen && <div className="scrim" onMouseDown={sheet.onBackdropMouseDown}>
          <section className="sheet" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={sheet.titleId}
            ref={sheet.ref as React.RefObject<HTMLElement>} onMouseDown={(event) => event.stopPropagation()}>
            <div className="sheet-head"><h2 id={sheet.titleId}>{tournamentTitle}</h2><button type="button" className="icon-btn" aria-label="ปิดเมนู" onClick={() => setSheetOpen(false)}>{icon(X, 20)}</button></div>
            {switchable && <div className="prototype-sheet-switcher">
              {admin && tournamentId ? <div className="sheet-tlink-row">
                <Link prefetch={false} scroll={false} href="/cards" className="sheet-tlink" onClick={() => setSheetOpen(false)}>
                  {icon(Trophy, 16)}<span>{tournamentTitle} · การ์ดทั้งหมด</span>{icon(ArrowRight, 14)}</Link>
                <button ref={switchTrigger} type="button" className="icon-btn sheet-tswitch" aria-haspopup="menu" aria-expanded={switchOpen === "sheet"}
                  aria-label="เปลี่ยนรายการแข่งขัน" onClick={() => openSwitcher("sheet")}>{icon(ChevronDown, 16)}</button>
              </div> : <button ref={switchTrigger} type="button" className="sheet-tlink" aria-expanded={switchOpen === "sheet"}
                onClick={() => openSwitcher("sheet")}>{icon(Trophy, 16)}<span>เปลี่ยนรายการแข่งขัน</span>{icon(ChevronDown, 14)}</button>}
              {switchOpen === "sheet" && menu}
            </div>}
            <div className="sidebar-like">
              {shortcuts.length > 0 && <p className="nav-label">ระบบ</p>}
              {shortcuts.map((item) => <PageLink key={item.href} item={item} path={pathname} onNavigate={() => setSheetOpen(false)} />)}
              {tournamentTitle && <p className="nav-label">{tournamentTitle}</p>}
              {renderTree(true)}
            </div>
            <div className="prototype-sheet-account meta">{auth.username} · {roleLabel}
              <button type="button" className="btn btn--sm btn--secondary" onClick={() => { setSheetOpen(false); setLogoutConfirm(true); }}>{icon(LogOut, 12)}ออกจากระบบ</button>
            </div>
          </section>
        </div>}
      </div>
      <ConfirmDialog appearance="prototype" open={logoutConfirm} eyebrow="ยืนยันการออกจากระบบ" icon={<LogOut size={20} />} title="ออกจากระบบ?"
        confirmLabel="ออกจากระบบ" busyLabel="กำลังออก…" busy={loggingOut} onConfirm={() => void confirmLogout()}
        onCancel={() => { if (!loggingOut) setLogoutConfirm(false); }}>
        <p>คุณกำลังจะออกจากบัญชี <strong>{auth.username}</strong></p>
      </ConfirmDialog>
      <Toaster /><GlobalDialogHost appearance="prototype" />
    </div>
  );
}

function OperatorSearch({ tournamentId, tournamentName, cardId, cardKeys }: {
  tournamentId?: string;
  tournamentName?: string;
  cardId?: string;
  cardKeys: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [player, setPlayer] = useState<{ cardId: string; code: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const requested = useRef(new Set<string>());
  const cards = useTournamentStore((state) => open || player ? state.cards : null);
  const syncCard = useTournamentStore((state) => state.syncCard);
  const profile = useModalDialog({ open: Boolean(player), onDismiss: () => setPlayer(null) });
  const keys = cardKeys.join(",");

  useEffect(() => {
    if (!open) return;
    field.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useEffect(() => {
    if (!open || !query.trim()) return;
    // Full card details are loaded lazily and through the same scoped API as normal navigation.
    const task = window.setTimeout(() => {
      for (const key of keys.split(",")) {
        if (!key || requested.current.has(key) || useTournamentStore.getState().cards.some((card) => card.id === key && !card.summaryOnly)) continue;
        requested.current.add(key);
        void syncCard(key).finally(() => requested.current.delete(key));
      }
    }, 150);
    return () => window.clearTimeout(task);
  }, [keys, open, query, syncCard]);

  const parsed = parseSearchQuery(query);
  const hits = parsed.kind === "empty" ? [] : (cards ?? [])
    .filter((card) => card.tournamentId === tournamentId && !card.summaryOnly)
    .sort((a, b) => Number(b.id === cardId) - Number(a.id === cardId))
    .flatMap((card) => card.players.filter((candidate) => parsed.kind === "codes"
      ? parsed.tokens.some((token) => matchesPlayerCode(candidate.id, token))
      : `${candidate.firstName} ${candidate.lastName} ${candidate.school}`.toLocaleLowerCase("th").includes(parsed.value.toLocaleLowerCase("th")))
      .map((candidate) => ({ card, candidate }))).slice(0, 20);
  const opened = player && cards?.find((card) => card.id === player.cardId && card.tournamentId === tournamentId);
  const payload = opened && publicDivisionPayload(opened);
  const choose = (hit: (typeof hits)[number]) => { setPlayer({ cardId: hit.card.id, code: hit.candidate.id }); setOpen(false); };
  const suggestions = open && parsed.kind !== "empty";
  return <div className="ms" data-open={open} ref={ref}>
    <button ref={trigger} type="button" className="ms__btn" aria-label="ค้นหานักกีฬา รหัส ชื่อ หรือโรงเรียน" aria-expanded={open} onClick={() => setOpen(true)}>{icon(Search, 18)}</button>
    <div className="ms__field" inert={!open}>
      <span className="ms__ico">{icon(Search, 16)}</span>
      <input ref={field} type="search" value={query} enterKeyHint="search" autoComplete="off" placeholder="รหัส ชื่อ หรือโรงเรียน"
        role="combobox" aria-label="ค้นหานักกีฬา" aria-expanded={suggestions} aria-autocomplete="list"
        aria-controls={suggestions ? "operator-search-results" : undefined} aria-activedescendant={suggestions && hits[activeIndex] ? `operator-search-hit-${activeIndex}` : undefined}
        onChange={(event) => { setQuery(event.target.value); setActiveIndex(-1); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && hits.length) {
            event.preventDefault();
            const offset = event.key === "ArrowDown" ? 1 : -1;
            setActiveIndex((index) => index < 0 ? offset > 0 ? 0 : hits.length - 1 : (index + offset + hits.length) % hits.length);
          }
          if (event.key === "Enter" && hits.length) { event.preventDefault(); choose(hits[activeIndex] ?? hits[0]); }
        }} />
      <button type="button" className="ms__clear" aria-label="ล้างคำค้นหา" hidden={!query} onClick={() => { setQuery(""); setActiveIndex(-1); field.current?.focus(); }}>{icon(X, 15)}</button>
    </div>
    {suggestions && <div className="pop pop--search prototype-operator-hits"><div className="lb" id="operator-search-results" role="listbox" aria-label="ผลการค้นหานักกีฬา">
      {hits.length ? hits.map(({ card, candidate }, index) => <button type="button" id={`operator-search-hit-${index}`} key={`${card.id}:${candidate.id}`}
        className="lb__opt ms-hit" role="option" aria-selected={index === activeIndex} tabIndex={-1} onClick={() => choose({ card, candidate })}>
        <span className="ms-hit__c code">{candidate.id}</span><span className="ms-hit__n"><b>{candidate.firstName} {candidate.lastName}</b><small>{candidate.school}</small></span>
        <span className="ms-hit__d">{card.name} · {card.division}</span>
      </button>) : <div className="lb__empty">ไม่พบนักกีฬา</div>}
    </div></div>}
    {opened && payload && player && <div className="prototype-search-dialog scrim" onMouseDown={profile.onBackdropMouseDown}>
      <section className="pm" ref={profile.ref as React.RefObject<HTMLElement>} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={profile.titleId}
        onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-head"><h2 id={profile.titleId}>รายละเอียดนักกีฬา</h2><button className="icon-btn" type="button" aria-label="ปิด" onClick={() => setPlayer(null)}>{icon(X, 20)}</button></div>
        <SpectatorParticipation card={payload} division={spectatorDivision(payload)}
          code={player.code} tournamentName={tournamentName} onBack={() => setPlayer(null)}
          onOpenPlayer={(nextId, code) => setPlayer({ cardId: nextId, code })}
          onBrowseDivision={() => { setPlayer(null); router.push(`/cards/${opened.id}`); }} />
      </section>
    </div>}
  </div>;
}
