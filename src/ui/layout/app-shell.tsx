"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  Bell,
  BellRing,
  ChevronRight,
  ClipboardList,
  Code2,
  FileClock,
  Folder,
  FolderOpen,
  Gamepad2,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  TableProperties,
  Trophy,
  Users,
  UserCog,
  ShieldCheck,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { readActiveTournament, selectCard, useTournamentStore } from "@/application/tournament/store";
import { useCardSync } from "@/application/tournament/use-card-sync";
import { usePublicSync } from "@/application/tournament/use-public-sync";
import { usePushNotifications, type PushNotificationScope, type PushToggleResult } from "@/application/tournament/use-push-notifications";
import { hasStaffAccess, isAdmin, isDirector, isOperator } from "@/domain/tournament/roles";
import type { RuntimeStage } from "@/domain/tournament/types";
import { toast } from "@/application/ui/toast";
import { Button } from "@/ui/components/button";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { Toaster } from "@/ui/components/toaster";
import { GlobalDialogHost } from "@/ui/components/global-dialog-host";

const OPENED_KEY = "ctwe.openedCards";
/** Historical key name; the stored "1" now simply means "sidebar expanded". */
const EXPANDED_KEY = "ctwe.sidebarLocked";

/** The page a staff member should work on next for a card at the given stage. */
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

const cardLinks = (id: string, isStaff: boolean) => isStaff ? [
  { href: `/cards/${id}`, label: "ภาพรวม", icon: Activity },
  { href: `/cards/${id}/players`, label: "ผู้เล่น", icon: Users },
  { href: `/cards/${id}/tables`, label: "โต๊ะแข่งขัน", icon: TableProperties },
  { href: `/cards/${id}/games`, label: "ผลการแข่งขัน", icon: Gamepad2 },
  { href: `/cards/${id}/audit`, label: "บันทึกกิจกรรม", icon: FileClock },
] : [{ href: `/cards/${id}`, label: "ภาพรวมการแข่งขัน", icon: Activity }];

function NavigationLink({ href, label, icon: Icon, active, workflow = false, collapsed = false, nested = false }: { href: string; label: string; icon: typeof ClipboardList; active: boolean; workflow?: boolean; collapsed?: boolean; nested?: boolean }) {
  const nudge = workflow && !active;
  return (
    <Link prefetch={false} className={`nav-link${active ? " nav-link--active" : ""}${nudge ? " nav-link--workflow" : ""}${nested ? " nav-link--nested" : ""}${collapsed ? " nav-link--icon" : ""}`} href={href} title={collapsed ? label : undefined} aria-current={active ? "page" : undefined}>
      <Icon size={18} aria-hidden="true" />
      {!collapsed && <span className="nav-link__text">{label}</span>}
      {!collapsed && nudge && <span className="nav-link__flag">ทำต่อ</span>}
    </Link>
  );
}

function CardFolder({ cardId, name, division, pages, expanded, current, workflowHref, pathname, onToggle, onClose, hideClose = false }: {
  cardId: string;
  name: string;
  division?: string;
  pages: { href: string; label: string; icon: typeof ClipboardList }[];
  expanded: boolean;
  current: boolean;
  workflowHref?: string;
  pathname: string;
  onToggle: () => void;
  onClose: () => void;
  hideClose?: boolean;
}) {
  return (
    <div className={`card-folder${current ? " card-folder--current" : ""}`}>
      <div className="card-folder__bar">
        <button type="button" className="card-folder__head" onClick={onToggle} aria-expanded={expanded}>
          <ChevronRight size={14} className={`card-folder__chevron${expanded ? " card-folder__chevron--open" : ""}`} aria-hidden="true" />
          {current ? <FolderOpen size={16} className="card-folder__icon" aria-hidden="true" /> : <Folder size={16} className="card-folder__icon" aria-hidden="true" />}
          <span className="card-folder__name"><strong>{name}</strong>{division && <small>{division}</small>}</span>
          {current && <span className="card-folder__here">ปัจจุบัน</span>}
        </button>
        {!hideClose && <button type="button" className="card-folder__close" onClick={onClose} aria-label={`ปิดการ์ด ${name}`}><X size={14} /></button>}
      </div>
      {expanded && (
        <div className="card-folder__pages">
          {pages.map((page) => <NavigationLink key={page.href} {...page} nested active={pathname === page.href} workflow={page.href === workflowHref} />)}
        </div>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const id = typeof params.id === "string" ? params.id : undefined;
  const auth = useTournamentStore((state) => state.auth);
  const cards = useTournamentStore((state) => state.cards);
  const activeTournament = useTournamentStore((state) => state.activeTournament);
  const setActiveTournament = useTournamentStore((state) => state.setActiveTournament);
  const logout = useTournamentStore((state) => state.logout);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  const [openedIds, setOpenedIds] = useState<string[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(true);   // sidebar shows the full menu; collapsed = icon rail
  const [hydrated, setHydrated] = useState(false);
  const [notificationConfirm, setNotificationConfirm] = useState(false);
  const isStaff = hasStaffAccess(auth);
  const admin = isAdmin(auth);
  const director = isDirector(auth);
  const roleLabel = admin ? "ADMIN" : director ? "DIRECTOR" : isStaff ? "STAFF" : "VIEWER";
  // Operators (director/staff) work inside a card's workspace pages; admins and public viewers only
  // watch, so they navigate to the read-only overview instead.
  const operator = isOperator(auth);
  // Staff and public viewers are locked to one tournament (no nav back). Directors and admins, who
  // span multiple tournaments, keep cross-tournament navigation (they exit a tournament from the
  // card list page, not the sidebar).
  const scopeLocked = !!activeTournament && !admin && !director;
  const currentCard = id ? selectCard(cards, id) : undefined;
  const previousFlowRef = useRef<{ cardId?: string; stage?: RuntimeStage }>({
    cardId: id,
    stage: currentCard?.runtimeStage,
  });
  // Live multi-user sync is a back-office concern; public viewers receive published snapshots only.
  useCardSync(isStaff ? id : undefined);
  usePublicSync(id, !isStaff);
  const onTournamentViewer = pathname.startsWith("/tour/") || pathname.startsWith("/t/");
  // Read-only overviews have no primary mobile navigation underneath their
  // Ranking/Pairing/Result bar, including tournament viewer routes without an `id` param.
  const standaloneOverview = !operator && (Boolean(id) || onTournamentViewer);
  const notificationScope: PushNotificationScope | null = !isStaff && id && pathname === `/cards/${id}`
    ? {
        type: "CARD",
        id,
        label: currentCard ? `${currentCard.name} · ${currentCard.division}` : "รุ่นการแข่งขันนี้",
      }
    : !isStaff && (pathname === "/cards" || onTournamentViewer) && activeTournament
      ? { type: "TOURNAMENT", id: activeTournament.id, label: activeTournament.name }
      : null;
  const { notificationsOn, pending: notificationPending, support: notificationSupport, enable: enableNotifications, disable: disableNotifications } =
    usePushNotifications(notificationScope);
  const showNotificationError = (result: PushToggleResult) => {
    if (result === "denied") toast.error("การแจ้งเตือนถูกปิดในเบราว์เซอร์ — เปิดใหม่ได้จากการตั้งค่าเว็บไซต์ของเบราว์เซอร์");
    else if (result === "unsupported") toast.error("อุปกรณ์นี้ยังใช้ Web Push ไม่ได้ — บน iPhone/iPad ให้เพิ่มเว็บไปหน้าจอโฮมก่อน");
    else if (result === "unavailable") toast.error("ระบบส่งแจ้งเตือนยังไม่ได้ตั้งค่ากุญแจสำหรับเซิร์ฟเวอร์");
    else if (result === "error") toast.error("ตั้งค่าการแจ้งเตือนไม่สำเร็จ กรุณาลองอีกครั้ง");
  };
  const handleNotificationButton = async () => {
    if (!notificationsOn) {
      setNotificationConfirm(true);
      return;
    }
    const result = await disableNotifications();
    showNotificationError(result);
    if (result === "granted") toast.success(`ปิดการแจ้งเตือน${notificationScope?.type === "CARD" ? "เฉพาะรุ่นนี้" : "ทั้งรายการ"}แล้ว`);
  };
  const confirmEnableNotifications = async () => {
    const result = await enableNotifications();
    showNotificationError(result);
    if (result === "granted") {
      setNotificationConfirm(false);
      toast.success(`เปิดการแจ้งเตือน${notificationScope?.type === "CARD" ? "เฉพาะรุ่นนี้" : "ทุกรุ่นในรายการนี้"}แล้ว`);
    }
  };
  // Entry is link-based now. Directors and admins reach their tournament list from "/"; each also
  // keeps the console relevant to their role.
  const generalLinks = [
    ...((director || admin) ? [{ href: "/", label: "รายการแข่งขันทั้งหมด", icon: Trophy }] : []),
    ...(isAdmin(auth) ? [{ href: "/admin", label: "ผู้ดูแลระบบ", icon: ShieldCheck }] : []),
    ...(isDirector(auth) ? [{ href: "/director", label: "คอนโซลผู้อำนวยการ", icon: UserCog }] : []),
    ...(isAdmin(auth) ? [{ href: "/dev-tools", label: "เครื่องมือนักพัฒนา", icon: Code2 }] : []),
  ];
  const tournamentCards = activeTournament ? cards.filter((card) => card.tournamentId === activeTournament.id) : [];

  // Restore the opened-card tabs and collapse state for this browser session.
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(OPENED_KEY) ?? "[]");
      if (Array.isArray(saved)) setOpenedIds(saved.filter((value): value is string => typeof value === "string"));
      const savedExpanded = sessionStorage.getItem(EXPANDED_KEY);
      if (savedExpanded !== null) setExpanded(savedExpanded === "1");
    } catch { /* ignore malformed storage */ }
    setActiveTournament(readActiveTournament());
    setHydrated(true);
  }, []);

  // Opening a card adds it as a tab and expands its folder.
  useEffect(() => {
    if (!id) return;
    setOpenedIds((prev) => prev.includes(id) ? prev : [...prev, id]);
    setExpandedIds((prev) => prev.has(id) ? prev : new Set(prev).add(id));
  }, [id]);

  // Follow a remote workflow transition only when this browser is still on the old workflow page.
  useEffect(() => {
    const nextStage = currentCard?.runtimeStage;
    const previous = previousFlowRef.current;
    previousFlowRef.current = { cardId: id, stage: nextStage };
    if (previous.cardId !== id) return;
    const previousStage = previous.stage;
    if (!isStaff || !id || !previousStage || !nextStage || previousStage === nextStage) return;
    if (pathname === stageHref(id, previousStage)) router.replace(stageHref(id, nextStage));
  }, [currentCard?.runtimeStage, id, isStaff, pathname, router]);

  useEffect(() => { if (hydrated) try { sessionStorage.setItem(OPENED_KEY, JSON.stringify(openedIds)); } catch { /* ignore */ } }, [openedIds, hydrated]);
  useEffect(() => { if (hydrated) try { sessionStorage.setItem(EXPANDED_KEY, expanded ? "1" : "0"); } catch { /* ignore */ } }, [expanded, hydrated]);

  const toggleFolder = (cardId: string) => setExpandedIds((prev) => {
    const next = new Set(prev);
    if (next.has(cardId)) next.delete(cardId); else next.add(cardId);
    return next;
  });
  const closeTab = (cardId: string) => {
    setOpenedIds((prev) => prev.filter((value) => value !== cardId));
    setExpandedIds((prev) => { const next = new Set(prev); next.delete(cardId); return next; });
    if (cardId === id) router.push("/cards");
  };

  const confirmLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
      setLogoutConfirm(false);
      // Logging out returns to the public master page (watch links + login).
      router.replace("/");
      router.refresh();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "ออกจากระบบไม่สำเร็จ");
    } finally {
      setLoggingOut(false);
    }
  };

  const railLinks = id ? cardLinks(id, operator) : generalLinks;
  const workflowHrefFor = (cardId: string) => {
    const card = selectCard(cards, cardId);
    return operator && card ? stageHref(cardId, card.runtimeStage) : undefined;
  };
  const collapsed = !expanded;

  return (
    <div className={`app-shell${expanded ? "" : " app-shell--collapsed"}`}>
      <aside className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`}>
        <div className="sidebar__head">
          {scopeLocked ? (
            <span className="brand" aria-label="Tournament Control">
              <span className="brand__mark"><Trophy size={20} /></span>
              <span className="brand__text" aria-hidden={collapsed}><strong>{activeTournament?.name ?? "Tournament Control"}</strong><small>ระบบจัดการแข่งขัน</small></span>
            </span>
          ) : (
            <Link prefetch={false} href="/" className="brand" aria-label="Tournament Control">
              <span className="brand__mark"><Trophy size={20} /></span>
              <span className="brand__text" aria-hidden={collapsed}><strong>Tournament Control</strong><small>ระบบจัดการแข่งขัน</small></span>
            </Link>
          )}
          <button type="button" className="sidebar__toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-label={expanded ? "หุบเมนูเป็นแถบไอคอน" : "ขยายเมนู"} title={expanded ? "หุบเมนูเป็นแถบไอคอน" : "ขยายเมนู"}>
            {expanded ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
        </div>

        {/* One menu, two densities: an icon rail when collapsed, the full tree when expanded. */}
        <nav className="sidebar__nav" aria-label="เมนูหลัก">
          {collapsed ? (
            <div className="sidebar__rail">
              {railLinks.map((link) => <NavigationLink key={link.href} {...link} collapsed active={pathname === link.href} workflow={id ? link.href === workflowHrefFor(id) : false} />)}
              {id && <NavigationLink href="/cards" label="การ์ดทั้งหมด" icon={ClipboardList} active={pathname === "/cards"} collapsed />}
            </div>
          ) : (
            <>
              {generalLinks.length > 0 && <p className="nav-label">ระบบ</p>}
              {generalLinks.map((link) => <NavigationLink key={link.href} {...link} active={pathname === link.href} />)}

              {isStaff ? (activeTournament ? (
                <>
                  <p className="nav-label nav-label--spaced">{activeTournament.name}</p>
                  {tournamentCards.length === 0 ? (
                    <p className="nav-empty">{operator ? "ยังไม่มีรุ่นการแข่งขัน — สร้างได้จากหน้าการ์ด" : "ยังไม่มีรุ่นการแข่งขันในรายการนี้"}</p>
                  ) : tournamentCards.map((card) => (
                    <CardFolder
                      key={card.id}
                      cardId={card.id}
                      name={card.name}
                      division={card.division}
                      pages={cardLinks(card.id, operator)}
                      expanded={expandedIds.has(card.id)}
                      current={card.id === id}
                      workflowHref={workflowHrefFor(card.id)}
                      pathname={pathname}
                      hideClose
                      onToggle={() => toggleFolder(card.id)}
                      onClose={() => undefined}
                    />
                  ))}
                </>
              ) : (
                <p className="nav-empty">{director
                  ? "เลือกรายการแข่งขันจาก “รายการแข่งขันทั้งหมด” เพื่อเริ่มจัดการ"
                  : "เลือกรายการแข่งขันจาก “รายการแข่งขันทั้งหมด” เพื่อเข้าชม"}</p>
              )) : (
                <>
                  <p className="nav-label nav-label--spaced">การ์ดที่เปิด{openedIds.length > 0 && ` · ${openedIds.length}`}</p>
                  {openedIds.length === 0 ? (
                    <p className="nav-empty">ยังไม่ได้เปิดการ์ด เลือกการ์ดจากหน้ารายการแล้วการ์ดจะมาอยู่ที่นี่</p>
                  ) : openedIds.map((cardId) => {
                    const card = selectCard(cards, cardId);
                    return (
                      <CardFolder
                        key={cardId}
                        cardId={cardId}
                        name={card?.name ?? cardId}
                        division={card?.division}
                        pages={cardLinks(cardId, isStaff)}
                        expanded={expandedIds.has(cardId)}
                        current={cardId === id}
                        workflowHref={workflowHrefFor(cardId)}
                        pathname={pathname}
                        onToggle={() => toggleFolder(cardId)}
                        onClose={() => closeTab(cardId)}
                      />
                    );
                  })}
                </>
              )}
            </>
          )}
        </nav>

        <div className="sidebar__footer">
          <span className="status-dot" />
          <span className="sidebar__footer-text" aria-hidden={collapsed}><strong>{isStaff ? auth.username : "Public viewer"}</strong><small>{isStaff ? roleLabel : "ดูข้อมูลเท่านั้น"}</small></span>
        </div>
        {isStaff ? (
          <div className="sidebar__auth-wrap"><Button type="button" variant="secondary" size="sm" className="sidebar__auth" onClick={() => setLogoutConfirm(true)} title="ออกจากระบบ"><LogOut size={15} /><span className="sidebar__auth-label">ออกจากระบบ</span></Button></div>
        ) : (
          notificationScope && <div className="sidebar__public-actions">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="sidebar__auth"
              disabled={notificationPending}
              onClick={() => void handleNotificationButton()}
              title={notificationsOn ? `ปิดการแจ้งเตือน: ${notificationScope.label}` : `เปิดการแจ้งเตือน: ${notificationScope.label}`}
            >
              {notificationsOn ? <BellRing size={15} /> : <Bell size={15} />}
              <span className="sidebar__auth-label">{notificationsOn ? "ปิดแจ้งเตือน" : "เปิดแจ้งเตือน"}</span>
            </Button>
          </div>
        )}
      </aside>
      <div className={`app-main${standaloneOverview ? " app-main--standalone-overview" : ""}`}>
        <div className="mobile-brand">
          {scopeLocked
            ? id && !isStaff
              ? <Link prefetch={false} href="/cards" className="mobile-brand__title mobile-brand__back" aria-label={`กลับไปเลือกกลุ่มรุ่นของ ${activeTournament?.name ?? "รายการแข่งขัน"}`}>
                  <ArrowLeft className="mobile-brand__back-icon" size={18} aria-hidden="true" />
                  <Trophy size={19} aria-hidden="true" />
                  <strong>{activeTournament?.name ?? "Tournament Control"}</strong>
                </Link>
              : <span className="mobile-brand__title"><Trophy size={19} /><strong>{activeTournament?.name ?? "Tournament Control"}</strong></span>
            : <Link prefetch={false} href="/" className="mobile-brand__title" aria-label="ไปหน้ารวมการแข่งขัน"><Trophy size={19} /><strong>Tournament Control</strong></Link>}
          <div className="mobile-brand__actions">
            {notificationScope && (
              <button
                type="button"
                className={`mobile-brand__auth${notificationsOn ? " mobile-brand__auth--enabled" : ""}`}
                disabled={notificationPending}
                onClick={() => void handleNotificationButton()}
                aria-label={notificationsOn ? `ปิดการแจ้งเตือน ${notificationScope.label}` : `เปิดการแจ้งเตือน ${notificationScope.label}`}
              >
                {notificationsOn ? <BellRing size={15} /> : <Bell size={15} />}
              </button>
            )}
            {isStaff && (
              <button type="button" className="mobile-brand__auth" onClick={() => setLogoutConfirm(true)}><LogOut size={15} />ออกจากระบบ</button>
            )}
          </div>
        </div>
        <main className="content">{children}</main>
        {operator && (
          <nav className="mobile-nav" aria-label="เมนูมือถือ">
            {railLinks.map((link) => <NavigationLink key={link.href} {...link} active={pathname === link.href} workflow={id ? link.href === workflowHrefFor(id) : false} />)}
          </nav>
        )}
      </div>

      <ConfirmDialog
        open={logoutConfirm}
        eyebrow="ยืนยันการออกจากระบบ"
        icon={<LogOut size={20} />}
        title="ออกจากระบบ?"
        confirmLabel="ออกจากระบบ"
        busyLabel="กำลังออก…"
        busy={loggingOut}
        onConfirm={() => void confirmLogout()}
        onCancel={() => { if (!loggingOut) setLogoutConfirm(false); }}
      >
        <p>คุณกำลังจะออกจากบัญชี <strong>{auth.username}</strong> — ยืนยันหรือไม่?</p>
      </ConfirmDialog>

      {notificationScope && (() => {
        const iosNeedsInstall = notificationSupport === "ios-needs-install";
        return (
          <ConfirmDialog
            open={notificationConfirm}
            eyebrow="การแจ้งเตือนบนอุปกรณ์"
            icon={<BellRing size={20} />}
            title={`เปิดแจ้งเตือน${notificationScope.type === "CARD" ? "เฉพาะรุ่นนี้" : "ทั้งรายการ"}?`}
            className="notification-consent"
            confirmLabel={iosNeedsInstall ? "เข้าใจแล้ว" : "อนุญาตแจ้งเตือน"}
            busyLabel="กำลังเปิด…"
            hideCancel={iosNeedsInstall}
            cancelLabel="ไว้ภายหลัง"
            busy={notificationPending}
            onConfirm={iosNeedsInstall ? () => setNotificationConfirm(false) : () => void confirmEnableNotifications()}
            onCancel={() => { if (!notificationPending) setNotificationConfirm(false); }}
          >
            <p>
              {notificationScope.type === "CARD"
                ? <>คุณจะได้รับแจ้งเตือนเฉพาะ <strong>{notificationScope.label}</strong></>
                : <>คุณจะได้รับแจ้งเตือนจาก <strong>ทุก card ใน {notificationScope.label}</strong></>}
            </p>
            <ul className="notification-consent__events">
              <li>Pairing ของแต่ละเกมถูกเผยแพร่</li>
              <li>Ranking ของแต่ละเกมถูกเผยแพร่</li>
              <li>รอบชิงเริ่มต้น</li>
              <li>การแข่งขันจบ พร้อมชื่อผู้ชนะอันดับ 1</li>
            </ul>
            <p className="notification-consent__privacy">แจ้งเตือนจะเด้งบนอุปกรณ์แม้ปิดหน้าเว็บหรือล็อกหน้าจอ · ระบบเก็บเฉพาะรหัสส่งข้อความที่เบราว์เซอร์สร้างให้ ไม่ขอชื่อ ตำแหน่ง หรือข้อมูลส่วนตัวของผู้ชม คุณปิดขอบเขตนี้ได้จากปุ่มเดิมทุกเมื่อ</p>
            {iosNeedsInstall && (
              <>
                <div className="notice notice--info"><p><strong>บน iPhone/iPad ต้องติดตั้งเว็บก่อน</strong><span>iOS จะส่งแจ้งเตือนได้เฉพาะเมื่อเพิ่มเว็บนี้ไว้ที่หน้าจอโฮม แล้วเปิดจากไอคอนนั้น</span></p></div>
                <ol className="notification-consent__events">
                  <li>แตะปุ่ม <strong>แชร์</strong> ในแถบล่างของ Safari</li>
                  <li>เลือก <strong>เพิ่มไปยังหน้าจอโฮม (Add to Home Screen)</strong></li>
                  <li>เปิดแอปจากไอคอนบนหน้าจอโฮม แล้วกดเปิดแจ้งเตือนอีกครั้ง</li>
                </ol>
              </>
            )}
          </ConfirmDialog>
        );
      })()}
      <Toaster />
      <GlobalDialogHost />
    </div>
  );
}
