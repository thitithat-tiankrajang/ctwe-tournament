"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { LockKeyhole, LogIn, ShieldCheck } from "lucide-react";
import { useTournamentStore } from "@/application/tournament/store";
import { Button } from "@/ui/components/button";
import { PageHeader, Panel } from "@/ui/components/page";

function StaffLoginForm() {
  const auth = useTournamentStore((state) => state.auth);
  const params = useSearchParams();
  return (
    <>
      <PageHeader eyebrow="Secure access" title="เข้าสู่ระบบเจ้าหน้าที่" description="บัญชีสมาชิกใช้สำหรับเจ้าหน้าที่ที่ได้รับอนุญาตให้เปลี่ยนแปลงข้อมูลเท่านั้น" />
      <Panel title="Staff authentication" description="ระบบใช้ server-side session, CSRF protection และไม่บันทึกรหัสผ่านไว้ใน browser storage">
        <form action="/login" method="post" className="panel-padding" style={{ maxWidth: 520, display: "grid", gap: 16 }}>
          {params.get("error") && <div className="notice notice--warning"><p><strong>เข้าสู่ระบบไม่สำเร็จ</strong><span>ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง</span></p></div>}
          <div className="notice notice--info"><ShieldCheck size={18} /><p><strong>บุคคลทั่วไปไม่จำเป็นต้องเข้าสู่ระบบ</strong><span>กลับไปหน้าการแข่งขันเพื่อดูข้อมูลแบบ read-only ได้ทันที</span></p></div>
          <div className="form-field"><label className="form-label" htmlFor="username">ชื่อผู้ใช้</label><input className="input" id="username" name="username" autoComplete="username" required /></div>
          <div className="form-field"><label className="form-label" htmlFor="password">รหัสผ่าน</label><input className="input" id="password" name="password" type="password" autoComplete="current-password" required /></div>
          <input type="hidden" name="_csrf" value={auth.csrfToken} />
          <div className="form-actions"><Link href="/cards"><Button type="button" variant="secondary">กลับหน้าสาธารณะ</Button></Link><Button type="submit" disabled={!auth.csrfToken}><LogIn size={16} />เข้าสู่ระบบ</Button></div>
        </form>
      </Panel>
      <div className="notice notice--warning"><LockKeyhole size={18} /><p><strong>ห้ามแชร์บัญชีเจ้าหน้าที่</strong><span>ทุกการเปลี่ยนแปลงจะบันทึกชื่อบัญชีไว้ใน audit log</span></p></div>
    </>
  );
}

export default function StaffLoginPage() {
  return <Suspense fallback={<div className="panel panel-padding">กำลังเตรียมหน้าลงชื่อเข้าใช้…</div>}><StaffLoginForm /></Suspense>;
}
