"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import {
  Activity,
  ClipboardList,
  Code2,
  FileClock,
  Gamepad2,
  LayoutDashboard,
  TableProperties,
  Trophy,
  Users,
  LogIn,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { FormEvent, useState } from "react";
import { useTournamentStore } from "@/application/tournament/store";
import { Button } from "@/ui/components/button";

const publicGeneralLinks = [
  { href: "/cards", label: "การ์ดแข่งขัน", icon: LayoutDashboard },
];

const cardLinks = (id: string, isStaff: boolean) => isStaff ? [
  { href: `/cards/${id}`, label: "ภาพรวม", icon: Activity },
  { href: `/cards/${id}/players`, label: "ผู้เล่น", icon: Users },
  { href: `/cards/${id}/tables`, label: "โต๊ะแข่งขัน", icon: TableProperties },
  { href: `/cards/${id}/games`, label: "ผลการแข่งขัน", icon: Gamepad2 },
  { href: `/cards/${id}/audit`, label: "บันทึกกิจกรรม", icon: FileClock },
] : [{ href: `/cards/${id}`, label: "ภาพรวมการแข่งขัน", icon: Activity }];

function NavigationLink({ href, label, icon: Icon, active }: { href: string; label: string; icon: typeof ClipboardList; active: boolean }) {
  return (
    <Link className={`nav-link ${active ? "nav-link--active" : ""}`} href={href}>
      <Icon size={18} aria-hidden="true" />
      <span>{label}</span>
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const id = typeof params.id === "string" ? params.id : undefined;
  const auth = useTournamentStore((state) => state.auth);
  const logout = useTournamentStore((state) => state.logout);
  const [loggingOut, setLoggingOut] = useState(false);
  const isStaff = auth.authenticated && auth.roles.includes("ROLE_STAFF");
  const generalLinks = isStaff ? [...publicGeneralLinks, { href: "/dev-tools", label: "เครื่องมือนักพัฒนา", icon: Code2 }] : publicGeneralLinks;
  const links = id ? cardLinks(id, isStaff) : generalLinks;

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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/cards" className="brand" aria-label="Tournament Control">
          <span className="brand__mark"><Trophy size={20} /></span>
          <span><strong>Tournament Control</strong><small>ระบบจัดการแข่งขัน</small></span>
        </Link>
        <nav className="sidebar__nav" aria-label="เมนูหลัก">
          <p className="nav-label">{id ? (isStaff ? "จัดการการ์ด" : "ข้อมูลสาธารณะ") : "ระบบ"}</p>
          {links.map((link) => (
            <NavigationLink key={link.href} {...link} active={pathname === link.href} />
          ))}
          {id && <NavigationLink href="/cards" label="การ์ดทั้งหมด" icon={ClipboardList} active={false} />}
        </nav>
        <div className="sidebar__footer">
          <span className="status-dot" />
          <span><strong>{isStaff ? auth.username : "Public viewer"}</strong><small>{isStaff ? "เจ้าหน้าที่" : "ดูข้อมูลเท่านั้น"}</small></span>
        </div>
        {isStaff ? (
          <form onSubmit={submitLogout} style={{ padding: "0 18px 18px" }}><Button type="submit" variant="secondary" size="sm" disabled={loggingOut}><ShieldCheck size={15} />{loggingOut ? "กำลังออก…" : "ออกจากระบบ"}</Button></form>
        ) : (
          <Link href="/staff-login" style={{ padding: "0 18px 18px" }}><Button variant="secondary" size="sm"><LogIn size={15} />เข้าสู่ระบบเจ้าหน้าที่</Button></Link>
        )}
      </aside>
      <div className="app-main">
        <div className="mobile-brand"><Trophy size={19} /><strong>Tournament Control</strong></div>
        <nav className="mobile-nav" aria-label="เมนูมือถือ">
          {links.map((link) => <NavigationLink key={link.href} {...link} active={pathname === link.href} />)}
        </nav>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
