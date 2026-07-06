"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { LockKeyhole, LogIn, ShieldCheck } from "lucide-react";
import { useTournamentStore } from "@/application/tournament/store";
import { Button } from "@/ui/components/button";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";
import { PageHeader, Panel } from "@/ui/components/page";

export default function StaffLoginPage() {
  const router = useRouter();
  const auth = useTournamentStore((state) => state.auth);
  const login = useTournamentStore((state) => state.login);
  const refreshAuth = useTournamentStore((state) => state.refreshAuth);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  useEffect(() => {
    if (!auth.csrfToken) void refreshAuth();
  }, [auth.csrfToken, refreshAuth]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await login(username, password);
      // The master page routes each role: staff into their tournament, director to their manage list.
      router.replace("/");
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "เข้าสู่ระบบไม่สำเร็จ");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <PageHeader eyebrow="Secure access" title="เข้าสู่ระบบ" description="ระบบเปิดให้เฉพาะผู้ดูแลระบบ ผู้อำนวยการ และเจ้าหน้าที่ — เข้าสู่ระบบเพื่อเข้าถึงข้อมูลการแข่งขัน" />
      <Panel title="Staff authentication" description="ระบบใช้ server-side session, CSRF protection และไม่บันทึกรหัสผ่านไว้ใน browser storage">
        <form onSubmit={submit} autoComplete="off" className="panel-padding" style={{ maxWidth: 520, display: "grid", gap: 16 }}>
          {error && <div className="notice notice--warning" role="alert"><p><strong>เข้าสู่ระบบไม่สำเร็จ</strong><span>{error}</span></p></div>}
          <div className="notice notice--info"><ShieldCheck size={18} /><p><strong>ต้องเข้าสู่ระบบก่อนจึงจะดูข้อมูลได้</strong><span>ผู้ดูแลระบบ ผู้อำนวยการ และเจ้าหน้าที่ ใช้บัญชีของตนเพื่อเข้าถึงรายการแข่งขัน</span></p></div>
          <div className="form-field"><label className="form-label" htmlFor="login-account">ชื่อผู้ใช้</label><input className="input" id="login-account" name="login-account" autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} required /></div>
          <div className="form-field"><label className="form-label" htmlFor="login-secret">รหัสผ่าน</label><FreshSecretInput id="login-secret" name="login-secret-value" className="input" value={password} onChange={(event) => setPassword(event.target.value)} required /></div>
          <div className="form-actions"><Button type="submit" disabled={!auth.csrfToken || submitting}><LogIn size={16} />{submitting ? "กำลังตรวจสอบ…" : "เข้าสู่ระบบ"}</Button></div>
        </form>
      </Panel>
      <div className="notice notice--warning"><LockKeyhole size={18} /><p><strong>ห้ามแชร์บัญชีเจ้าหน้าที่</strong><span>ทุกการเปลี่ยนแปลงจะบันทึกชื่อบัญชีไว้ใน audit log</span></p></div>
    </>
  );
}
