"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { LockKeyhole, LogIn } from "lucide-react";
import { useTournamentStore } from "@/application/tournament/store";
import { FreshSecretInput } from "@/ui/components/fresh-secret-input";
import { SystemOffPanel } from "@/ui/components/system-off-panel";
import { fetchSystemState, systemIsOff, type SystemState } from "@/infrastructure/http/system-state";

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
  // Architecture §21: when the operator has declared the system off, say so instead of offering a
  // form that cannot succeed. Fails toward the form — an unreadable state file changes nothing.
  const [systemState, setSystemState] = useState<SystemState | null>(null);
  useEffect(() => { void fetchSystemState().then(setSystemState); }, []);
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

  if (systemIsOff(systemState) && systemState) {
    return (
      <>
        <div className="page-head"><div className="ttl"><span className="eyebrow">ระบบจัดการแข่งขัน</span><h1>เข้าสู่ระบบ</h1></div></div>
        <SystemOffPanel state={systemState}>
          <p className="console-note">· ผู้จัด: ต้องเริ่มระบบก่อนจึงจะเข้าสู่ระบบได้</p>
        </SystemOffPanel>
      </>
    );
  }

  return (
    <>
      <div className="page-head"><div className="ttl"><span className="eyebrow">ระบบจัดการแข่งขัน</span><h1>เข้าสู่ระบบ</h1></div></div>
      <section className="panel"><div className="panel-head"><h2>ยืนยันตัวตน</h2></div>
        <form onSubmit={submit} autoComplete="off" className="panel-body prototype-login">
          {sessionExpired && !error && <div className="notice notice--warning" role="alert"><LockKeyhole size={18} /><p><strong>เซสชันหมดอายุ</strong><span>เพื่อความปลอดภัย ระบบได้ออกจากระบบให้อัตโนมัติ — กรุณาเข้าสู่ระบบอีกครั้ง</span></p></div>}
          {error && <div className="notice notice--warning" role="alert"><p><strong>เข้าสู่ระบบไม่สำเร็จ</strong><span>{error}</span></p></div>}
          <div className="field"><label htmlFor="login-account">ชื่อผู้ใช้</label><input className="input" id="login-account" name="login-account" autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} required /></div>
          <div className="field"><label htmlFor="login-secret">รหัสผ่าน</label><FreshSecretInput id="login-secret" name="login-secret-value" className="input" value={password} onChange={(event) => setPassword(event.target.value)} required /></div>
          <div className="form-row prototype-form-end"><button className="btn btn--primary" type="submit" disabled={!auth.csrfToken || submitting}><LogIn className="i" size={16} />{submitting ? "กำลังตรวจสอบ…" : "เข้าสู่ระบบ"}</button></div>
        </form>
      </section>
      <div className="notice notice--warning"><LockKeyhole size={18} /><p><strong>ห้ามแชร์บัญชีเจ้าหน้าที่</strong><span>ทุกการเปลี่ยนแปลงจะบันทึกชื่อบัญชีไว้ใน audit log</span></p></div>
    </>
  );
}
