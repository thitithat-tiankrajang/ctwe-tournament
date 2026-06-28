"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { LockKeyhole, LogIn, ShieldCheck } from "lucide-react";
import { useTournamentStore } from "@/application/tournament/store";
import { Button } from "@/ui/components/button";
import { PageHeader, Panel } from "@/ui/components/page";

export default function StaffLoginPage() {
  const router = useRouter();
  const auth = useTournamentStore((state) => state.auth);
  const login = useTournamentStore((state) => state.login);
  const refreshAuth = useTournamentStore((state) => state.refreshAuth);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (!auth.csrfToken) void refreshAuth();
  }, [auth.csrfToken, refreshAuth]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError("");
    setSubmitting(true);
    try {
      await login(String(data.get("username") ?? ""), String(data.get("password") ?? ""));
      router.replace("/cards");
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "เข้าสู่ระบบไม่สำเร็จ");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <PageHeader eyebrow="Secure access" title="เข้าสู่ระบบเจ้าหน้าที่" description="บัญชีสมาชิกใช้สำหรับเจ้าหน้าที่ที่ได้รับอนุญาตให้เปลี่ยนแปลงข้อมูลเท่านั้น" />
      <Panel title="Staff authentication" description="ระบบใช้ server-side session, CSRF protection และไม่บันทึกรหัสผ่านไว้ใน browser storage">
        <form onSubmit={submit} className="panel-padding" style={{ maxWidth: 520, display: "grid", gap: 16 }}>
          {error && <div className="notice notice--warning" role="alert"><p><strong>เข้าสู่ระบบไม่สำเร็จ</strong><span>{error}</span></p></div>}
          <div className="notice notice--info"><ShieldCheck size={18} /><p><strong>บุคคลทั่วไปไม่จำเป็นต้องเข้าสู่ระบบ</strong><span>กลับไปหน้าการแข่งขันเพื่อดูข้อมูลแบบ read-only ได้ทันที</span></p></div>
          <div className="form-field"><label className="form-label" htmlFor="username">ชื่อผู้ใช้</label><input className="input" id="username" name="username" autoComplete="username" required /></div>
          <div className="form-field"><label className="form-label" htmlFor="password">รหัสผ่าน</label><input className="input" id="password" name="password" type="password" autoComplete="current-password" required /></div>
          <div className="form-actions"><Link href="/cards"><Button type="button" variant="secondary">กลับหน้าสาธารณะ</Button></Link><Button type="submit" disabled={!auth.csrfToken || submitting}><LogIn size={16} />{submitting ? "กำลังตรวจสอบ…" : "เข้าสู่ระบบ"}</Button></div>
        </form>
      </Panel>
      <div className="notice notice--warning"><LockKeyhole size={18} /><p><strong>ห้ามแชร์บัญชีเจ้าหน้าที่</strong><span>ทุกการเปลี่ยนแปลงจะบันทึกชื่อบัญชีไว้ใน audit log</span></p></div>
    </>
  );
}
