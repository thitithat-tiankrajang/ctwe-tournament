"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { LockKeyhole, LogIn } from "lucide-react";
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
  // Arrived here because a staff session died mid-use (?expired=1) — say so above the form.
  const [sessionExpired, setSessionExpired] = useState(false);
  useEffect(() => {
    setSessionExpired(new URLSearchParams(window.location.search).get("expired") === "1");
  }, []);
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
      <PageHeader eyebrow="ระบบจัดการแข่งขัน" title="เข้าสู่ระบบ" description="สำหรับผู้ดูแลระบบ ผู้อำนวยการ และเจ้าหน้าที่กรอกผลเท่านั้น" />
      <Panel title="ยืนยันตัวตน" description="ใช้บัญชีที่ได้รับจากผู้ดูแลระบบหรือผู้อำนวยการของคุณ">
        <form onSubmit={submit} autoComplete="off" className="panel-padding" style={{ maxWidth: 520, display: "grid", gap: 16 }}>
          {sessionExpired && !error && <div className="notice notice--warning" role="alert"><LockKeyhole size={18} /><p><strong>เซสชันหมดอายุ</strong><span>เพื่อความปลอดภัย ระบบได้ออกจากระบบให้อัตโนมัติ — กรุณาเข้าสู่ระบบอีกครั้ง</span></p></div>}
          {error && <div className="notice notice--warning" role="alert"><p><strong>เข้าสู่ระบบไม่สำเร็จ</strong><span>{error}</span></p></div>}
          <div className="form-field"><label className="form-label" htmlFor="login-account">ชื่อผู้ใช้</label><input className="input" id="login-account" name="login-account" autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} required /></div>
          <div className="form-field"><label className="form-label" htmlFor="login-secret">รหัสผ่าน</label><FreshSecretInput id="login-secret" name="login-secret-value" className="input" value={password} onChange={(event) => setPassword(event.target.value)} required /></div>
          <div className="form-actions"><Button type="submit" disabled={!auth.csrfToken || submitting}><LogIn size={16} />{submitting ? "กำลังตรวจสอบ…" : "เข้าสู่ระบบ"}</Button></div>
        </form>
      </Panel>
      <div className="notice notice--warning"><LockKeyhole size={18} /><p><strong>ห้ามแชร์บัญชีเจ้าหน้าที่</strong><span>ทุกการเปลี่ยนแปลงจะบันทึกชื่อบัญชีไว้ใน audit log</span></p></div>
    </>
  );
}
