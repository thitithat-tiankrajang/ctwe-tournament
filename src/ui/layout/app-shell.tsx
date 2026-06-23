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
  PanelLeftClose,
  PanelLeftOpen,
  TableProperties,
  Trophy,
  Users,
  LogIn,
  ShieldCheck,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { FormEvent, useEffect, useState } from "react";
import { selectCard, useTournamentStore } from "@/application/tournament/store";
import type { RuntimeStage } from "@/domain/tournament/types";
import { Button } from "@/ui/components/button";

const OPENED_KEY = "ctwe.openedCards";
const COLLAPSED_KEY = "ctwe.sidebarCollapsed";

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

function CardFolder({ cardId, name, division, pages, expanded, current, workflowHref, pathname, onToggle, onClose }: {
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
        <button type="button" className="card-folder__close" onClick={onClose} aria-label={`ปิดการ์ด ${name}`}><X size={14} /></button>
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
  const logout = useTournamentStore((state) => state.logout);
  const [loggingOut, setLoggingOut] = useState(false);
  const [openedIds, setOpenedIds] = useState<string[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const isStaff = auth.authenticated && auth.roles.includes("ROLE_STAFF");
  const generalLinks = isStaff ? [...publicGeneralLinks, { href: "/dev-tools", label: "เครื่องมือนักพัฒนา", icon: Code2 }] : publicGeneralLinks;

  // Restore the opened-card tabs and collapse state for this browser session.
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(OPENED_KEY) ?? "[]");
      if (Array.isArray(saved)) setOpenedIds(saved.filter((value): value is string => typeof value === "string"));
      setCollapsed(sessionStorage.getItem(COLLAPSED_KEY) === "1");
    } catch { /* ignore malformed storage */ }
    setHydrated(true);
  }, []);

  // Opening a card adds it as a tab and expands its folder.
  useEffect(() => {
    if (!id) return;
    setOpenedIds((prev) => prev.includes(id) ? prev : [...prev, id]);
    setExpandedIds((prev) => prev.has(id) ? prev : new Set(prev).add(id));
  }, [id]);

  useEffect(() => { if (hydrated) try { sessionStorage.setItem(OPENED_KEY, JSON.stringify(openedIds)); } catch { /* ignore */ } }, [openedIds, hydrated]);
  useEffect(() => { if (hydrated) try { sessionStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0"); } catch { /* ignore */ } }, [collapsed, hydrated]);

  // Collapse the sidebar to a rail the moment staff start typing in the content area.
  useEffect(() => {
    const main = document.querySelector(".app-main");
    if (!main) return;
    const onFocusIn = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches?.("input, textarea, select")) setCollapsed(true);
    };
    main.addEventListener("focusin", onFocusIn);
    return () => main.removeEventListener("focusin", onFocusIn);
  }, []);

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

  const submitLogout = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoggingOut(true);
    try {
      await logout();
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

  return (
    <div className={`app-shell${collapsed ? " app-shell--collapsed" : ""}`}>
      <aside className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`}>
        <div className="sidebar__head">
          <Link href="/cards" className="brand" aria-label="Tournament Control">
            <span className="brand__mark"><Trophy size={20} /></span>
            <span className="brand__text"><strong>Tournament Control</strong><small>ระบบจัดการแข่งขัน</small></span>
          </Link>
          <button type="button" className="sidebar__toggle" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "ขยายเมนู" : "ยุบเมนู"} aria-expanded={!collapsed} title={collapsed ? "ขยายเมนู" : "ยุบเมนู"}>
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
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
        </nav>

        <div className="sidebar__footer">
          <span className="status-dot" />
          <span className="sidebar__footer-text"><strong>{isStaff ? auth.username : "Public viewer"}</strong><small>{isStaff ? "เจ้าหน้าที่" : "ดูข้อมูลเท่านั้น"}</small></span>
        </div>
        {isStaff ? (
          <form onSubmit={submitLogout} className="sidebar__auth-wrap"><Button type="submit" variant="secondary" size="sm" className="sidebar__auth" disabled={loggingOut} title="ออกจากระบบ"><ShieldCheck size={15} /><span className="sidebar__auth-label">{loggingOut ? "กำลังออก…" : "ออกจากระบบ"}</span></Button></form>
        ) : (
          <Link href="/staff-login" className="sidebar__auth-wrap"><Button variant="secondary" size="sm" className="sidebar__auth" title="เข้าสู่ระบบเจ้าหน้าที่"><LogIn size={15} /><span className="sidebar__auth-label">เข้าสู่ระบบเจ้าหน้าที่</span></Button></Link>
        )}
      </aside>
      <div className="app-main">
        <div className="mobile-brand"><Trophy size={19} /><strong>Tournament Control</strong></div>
        <nav className="mobile-nav" aria-label="เมนูมือถือ">
          {railLinks.map((link) => <NavigationLink key={link.href} {...link} active={pathname === link.href} workflow={id ? link.href === workflowHrefFor(id) : false} />)}
        </nav>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
