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
  Lock,
  LockOpen,
  LoaderCircle,
  LogOut,
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
import { Toaster } from "@/ui/components/toaster";

const OPENED_KEY = "ctwe.openedCards";
const LOCKED_KEY = "ctwe.sidebarLocked";

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
    <Link className={`nav-link${active ? " nav-link--active" : ""}${nudge ? " nav-link--workflow" : ""}${nested ? " nav-link--nested" : ""}${collapsed ? " nav-link--icon" : ""}`} href={href} title={collapsed ? label : undefined} aria-current={active ? "page" : undefined}>
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
  const [locked, setLocked] = useState(true);   // sidebar pinned open; when unlocked it expands on hover
  const [hovering, setHovering] = useState(false);
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
  const notificationScope: PushNotificationScope | null = !isStaff && id && pathname === `/cards/${id}`
    ? {
        type: "CARD",
        id,
        label: currentCard ? `${currentCard.name} · ${currentCard.division}` : "รุ่นการแข่งขันนี้",
      }
    : !isStaff && pathname === "/cards" && activeTournament
      ? { type: "TOURNAMENT", id: activeTournament.id, label: activeTournament.name }
      : null;
  const { notificationsOn, pending: notificationPending, enable: enableNotifications, disable: disableNotifications } =
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
    ...(isDirector(auth) ? [{ href: "/director", label: "จัดการเจ้าหน้าที่", icon: UserCog }] : []),
    ...(isAdmin(auth) ? [{ href: "/dev-tools", label: "เครื่องมือนักพัฒนา", icon: Code2 }] : []),
  ];
  const tournamentCards = activeTournament ? cards.filter((card) => card.tournamentId === activeTournament.id) : [];

  // Restore the opened-card tabs and collapse state for this browser session.
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(OPENED_KEY) ?? "[]");
      if (Array.isArray(saved)) setOpenedIds(saved.filter((value): value is string => typeof value === "string"));
      const savedLock = sessionStorage.getItem(LOCKED_KEY);
      if (savedLock !== null) setLocked(savedLock === "1");
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
  useEffect(() => { if (hydrated) try { sessionStorage.setItem(LOCKED_KEY, locked ? "1" : "0"); } catch { /* ignore */ } }, [locked, hydrated]);

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
  // Expanded when pinned (locked) OR temporarily hovered; otherwise a narrow rail.
  const collapsed = !(locked || hovering);

  return (
    <div className={`app-shell${locked ? "" : " app-shell--collapsed"}`}>
      <aside
        className={`sidebar${collapsed ? " sidebar--collapsed" : ""}${!locked && hovering ? " sidebar--floating" : ""}`}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <div className="sidebar__head">
          {scopeLocked ? (
            <span className="brand" aria-label="Tournament Control">
              <span className="brand__mark"><Trophy size={20} /></span>
              <span className="brand__text" aria-hidden={collapsed}><strong>{activeTournament?.name ?? "Tournament Control"}</strong><small>ระบบจัดการแข่งขัน</small></span>
            </span>
          ) : (
            <Link href="/" className="brand" aria-label="Tournament Control">
              <span className="brand__mark"><Trophy size={20} /></span>
              <span className="brand__text" aria-hidden={collapsed}><strong>Tournament Control</strong><small>ระบบจัดการแข่งขัน</small></span>
            </Link>
          )}
          <button type="button" className={`sidebar__toggle${locked ? " sidebar__toggle--locked" : ""}`} onClick={() => setLocked((value) => !value)} aria-pressed={locked} aria-label={locked ? "ปลดล็อกเมนู (เลื่อนเมาส์เพื่อเปิด/หุบ)" : "ล็อกเมนูให้เปิดค้าง"} title={locked ? "ล็อกอยู่: เปิดค้างตลอด — กดเพื่อใช้โหมดเลื่อนเมาส์ชี้" : "โหมดเลื่อนเมาส์: ชี้เพื่อเปิด หุบเมื่อเอาเมาส์ออก — กดเพื่อล็อกเปิดค้าง"}>
            {locked ? <Lock size={16} /> : <LockOpen size={16} />}
          </button>
        </div>

        <nav className="sidebar__nav" aria-label="เมนูหลัก">
          <div className={`sidebar__nav-layer sidebar__nav-layer--rail${collapsed ? " sidebar__nav-layer--active" : ""}`} aria-hidden={!collapsed}>
            <div className="sidebar__rail">
              {railLinks.map((link) => <NavigationLink key={link.href} {...link} collapsed active={pathname === link.href} workflow={id ? link.href === workflowHrefFor(id) : false} />)}
              {id && <NavigationLink href="/cards" label="การ์ดทั้งหมด" icon={ClipboardList} active={pathname === "/cards"} collapsed />}
            </div>
          </div>
          <div className={`sidebar__nav-layer sidebar__nav-layer--expanded${collapsed ? "" : " sidebar__nav-layer--active"}`} aria-hidden={collapsed}>
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
          </div>
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
      <div className={`app-main${id && !isStaff ? " app-main--public-card" : ""}`}>
        <div className="mobile-brand">
          {scopeLocked
            ? id && !isStaff
              ? <Link href="/cards" className="mobile-brand__title mobile-brand__back" aria-label={`กลับไปเลือกกลุ่มรุ่นของ ${activeTournament?.name ?? "รายการแข่งขัน"}`}>
                  <ArrowLeft className="mobile-brand__back-icon" size={18} aria-hidden="true" />
                  <Trophy size={19} aria-hidden="true" />
                  <strong>{activeTournament?.name ?? "Tournament Control"}</strong>
                </Link>
              : <span className="mobile-brand__title"><Trophy size={19} /><strong>{activeTournament?.name ?? "Tournament Control"}</strong></span>
            : <Link href="/" className="mobile-brand__title" aria-label="ไปหน้ารวมการแข่งขัน"><Trophy size={19} /><strong>Tournament Control</strong></Link>}
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

      {logoutConfirm && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => !loggingOut && setLogoutConfirm(false)}>
          <section className="confirm-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <header><div className="confirm-dialog__icon"><LogOut size={20} /></div><div><span>ยืนยันการออกจากระบบ</span><h2>ออกจากระบบ?</h2></div><button className="confirm-dialog__close" type="button" aria-label="ปิด" disabled={loggingOut} onClick={() => setLogoutConfirm(false)}><X size={18} /></button></header>
            <p>คุณกำลังจะออกจากบัญชี <strong>{auth.username}</strong> — ยืนยันหรือไม่?</p>
            <footer>
              <Button variant="secondary" disabled={loggingOut} onClick={() => setLogoutConfirm(false)}>ยกเลิก</Button>
              <Button disabled={loggingOut} onClick={() => void confirmLogout()}>{loggingOut ? <LoaderCircle className="loading-spinner" size={16} /> : <LogOut size={16} />}{loggingOut ? "กำลังออก…" : "ออกจากระบบ"}</Button>
            </footer>
          </section>
        </div>
      )}
      {notificationConfirm && notificationScope && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => !notificationPending && setNotificationConfirm(false)}>
          <section className="confirm-dialog notification-consent" role="dialog" aria-modal="true" aria-labelledby="notification-consent-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div className="confirm-dialog__icon"><BellRing size={20} /></div>
              <div><span>การแจ้งเตือนบนอุปกรณ์</span><h2 id="notification-consent-title">เปิดแจ้งเตือน{notificationScope.type === "CARD" ? "เฉพาะรุ่นนี้" : "ทั้งรายการ"}?</h2></div>
              <button className="confirm-dialog__close" type="button" aria-label="ปิด" disabled={notificationPending} onClick={() => setNotificationConfirm(false)}><X size={18} /></button>
            </header>
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
            <p className="notification-consent__privacy">ระบบเก็บเฉพาะรหัสส่งข้อความที่เบราว์เซอร์สร้างให้ ไม่ขอชื่อ ตำแหน่ง หรือข้อมูลส่วนตัวของผู้ชม คุณปิดขอบเขตนี้ได้จากปุ่มเดิมทุกเมื่อ</p>
            <footer>
              <Button variant="secondary" disabled={notificationPending} onClick={() => setNotificationConfirm(false)}>ไว้ภายหลัง</Button>
              <Button disabled={notificationPending} onClick={() => void confirmEnableNotifications()}>
                {notificationPending ? <LoaderCircle className="loading-spinner" size={16} /> : <BellRing size={16} />}
                {notificationPending ? "กำลังเปิด…" : "อนุญาตแจ้งเตือน"}
              </Button>
            </footer>
          </section>
        </div>
      )}
      <Toaster />
    </div>
  );
}
