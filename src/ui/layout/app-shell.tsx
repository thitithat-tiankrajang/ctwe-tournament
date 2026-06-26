"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import {
  Activity,
  ChevronRight,
  ClipboardList,
  Code2,
  FileClock,
  Folder,
  FolderOpen,
  Gamepad2,
  LayoutDashboard,
  Lock,
  LockOpen,
  LoaderCircle,
  LogOut,
  TableProperties,
  Trophy,
  Users,
  UserCog,
  LogIn,
  ShieldCheck,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { readActiveTournament, selectCard, useTournamentStore } from "@/application/tournament/store";
import { useCardSync } from "@/application/tournament/use-card-sync";
import { hasStaffAccess, isAdmin, isDirector } from "@/domain/tournament/roles";
import type { RuntimeStage } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";

const OPENED_KEY = "ctwe.openedCards";
const LOCKED_KEY = "ctwe.sidebarLocked";

const publicGeneralLinks = [
  { href: "/cards", label: "การ์ดแข่งขัน", icon: LayoutDashboard },
];

/** The page a staff member should work on next for a card at the given stage. */
function stageHref(id: string, stage: RuntimeStage) {
  switch (stage) {
    case "PLAYER_REGISTRATION": return `/cards/${id}/players`;
    case "TABLE_PAIRING":
    case "PAIRING_PREVIEW": return `/cards/${id}/tables`;
    case "RESULT_COLLECTION":
    case "RESULT_REVIEW": return `/cards/${id}/games`;
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
  const isStaff = hasStaffAccess(auth);
  // Live multi-user sync: poll the open card so concurrent staff/directors see each other's edits.
  useCardSync(id);
  const generalLinks = [
    ...(isStaff ? [{ href: "/tournaments", label: "รายการแข่งขัน", icon: Trophy }] : publicGeneralLinks),
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
      router.replace("/cards");
      router.refresh();
    } catch (failure) {
      window.alert(failure instanceof Error ? failure.message : "ออกจากระบบไม่สำเร็จ");
    } finally {
      setLoggingOut(false);
    }
  };

  const railLinks = id ? cardLinks(id, isStaff) : generalLinks;
  const workflowHrefFor = (cardId: string) => {
    const card = selectCard(cards, cardId);
    return isStaff && card ? stageHref(cardId, card.runtimeStage) : undefined;
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
          <Link href="/cards" className="brand" aria-label="Tournament Control">
            <span className="brand__mark"><Trophy size={20} /></span>
            <span className="brand__text"><strong>Tournament Control</strong><small>ระบบจัดการแข่งขัน</small></span>
          </Link>
          <button type="button" className={`sidebar__toggle${locked ? " sidebar__toggle--locked" : ""}`} onClick={() => setLocked((value) => !value)} aria-pressed={locked} aria-label={locked ? "ปลดล็อกเมนู (เลื่อนเมาส์เพื่อเปิด/หุบ)" : "ล็อกเมนูให้เปิดค้าง"} title={locked ? "ล็อกอยู่: เปิดค้างตลอด — กดเพื่อใช้โหมดเลื่อนเมาส์ชี้" : "โหมดเลื่อนเมาส์: ชี้เพื่อเปิด หุบเมื่อเอาเมาส์ออก — กดเพื่อล็อกเปิดค้าง"}>
            {locked ? <Lock size={16} /> : <LockOpen size={16} />}
          </button>
        </div>

        <nav className="sidebar__nav" aria-label="เมนูหลัก">
          {collapsed ? (
            <div className="sidebar__rail">
              {railLinks.map((link) => <NavigationLink key={link.href} {...link} collapsed active={pathname === link.href} workflow={id ? link.href === workflowHrefFor(id) : false} />)}
              {id && <NavigationLink href="/cards" label="การ์ดทั้งหมด" icon={ClipboardList} active={pathname === "/cards"} collapsed />}
            </div>
          ) : (
            <>
              <p className="nav-label">ระบบ</p>
              {generalLinks.map((link) => <NavigationLink key={link.href} {...link} active={pathname === link.href} />)}

              {isStaff ? (activeTournament ? (
                <>
                  <p className="nav-label nav-label--spaced">{activeTournament.name}</p>
                  <button type="button" className="nav-empty nav-tournament-close" style={{ cursor: "pointer", background: "none", border: "none", textAlign: "left", width: "100%", display: "flex", alignItems: "center", gap: 6 }} onClick={() => { setActiveTournament(null); router.push("/tournaments"); }}><X size={12} /> ออกจากรายการแข่งขันนี้</button>
                  {tournamentCards.length === 0 ? (
                    <p className="nav-empty">ยังไม่มีรุ่นการแข่งขัน — สร้างได้จากหน้าการ์ด</p>
                  ) : tournamentCards.map((card) => (
                    <CardFolder
                      key={card.id}
                      cardId={card.id}
                      name={card.name}
                      division={card.division}
                      pages={cardLinks(card.id, isStaff)}
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
                <p className="nav-empty">เข้าสู่รายการแข่งขันจาก “รายการแข่งขัน” เพื่อจัดการรุ่นการแข่งขัน</p>
              )) : (
                <>
                  <p className="nav-label nav-label--spaced">การ์ดที่เปิด{openedIds.length > 0 && ` · ${openedIds.length}`}</p>
                  {openedIds.length === 0 ? (
                    <p className="nav-empty">ยังไม่ได้เปิดการ์ด เลือกจาก “การ์ดแข่งขัน” แล้วการ์ดจะมาอยู่ที่นี่</p>
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
          <span className="sidebar__footer-text"><strong>{isStaff ? auth.username : "Public viewer"}</strong><small>{isStaff ? "เจ้าหน้าที่" : "ดูข้อมูลเท่านั้น"}</small></span>
        </div>
        {isStaff ? (
          <div className="sidebar__auth-wrap"><Button type="button" variant="secondary" size="sm" className="sidebar__auth" onClick={() => setLogoutConfirm(true)} title="ออกจากระบบ"><LogOut size={15} /><span className="sidebar__auth-label">ออกจากระบบ</span></Button></div>
        ) : (
          <Link href="/staff-login" className="sidebar__auth-wrap"><Button variant="secondary" size="sm" className="sidebar__auth" title="เข้าสู่ระบบเจ้าหน้าที่"><LogIn size={15} /><span className="sidebar__auth-label">เข้าสู่ระบบเจ้าหน้าที่</span></Button></Link>
        )}
      </aside>
      <div className="app-main">
        <div className="mobile-brand">
          <div className="mobile-brand__title"><Trophy size={19} /><strong>Tournament Control</strong></div>
          {isStaff ? (
            <button type="button" className="mobile-brand__auth" onClick={() => setLogoutConfirm(true)}><LogOut size={15} />ออกจากระบบ</button>
          ) : (
            <Link href="/staff-login" className="mobile-brand__auth mobile-brand__auth--login"><LogIn size={15} />เข้าสู่ระบบ</Link>
          )}
        </div>
        <main className="content">{children}</main>
        <nav className="mobile-nav" aria-label="เมนูมือถือ">
          {railLinks.map((link) => <NavigationLink key={link.href} {...link} active={pathname === link.href} workflow={id ? link.href === workflowHrefFor(id) : false} />)}
        </nav>
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
    </div>
  );
}
