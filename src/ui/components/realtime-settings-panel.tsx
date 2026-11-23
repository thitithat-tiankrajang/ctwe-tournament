"use client";

import { PrototypeViewerHelp } from "./prototype-spectator-chrome";
import { Activity, RadioTower } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTournamentStore, type RealtimeSettings, type RealtimeSettingsInput } from "@/application/tournament/store";
import { toast } from "@/application/ui/toast";


/** The panel edits only the SSE-relevant subset; polling fields pass through untouched. */
const numericFields = [
  { key: "maxPublicSseConnections", title: "การเชื่อมต่อผู้ชมสูงสุด", min: 0, max: 1500 },
  { key: "maxStaffSseConnections", title: "การเชื่อมต่อเจ้าหน้าที่สูงสุด", min: 0, max: 1000 },
  { key: "heartbeatIntervalMs", title: "Heartbeat", min: 5000, max: 120000, unit: "ms" },
  { key: "reconnectDelayMs", title: "หน่วงก่อนเชื่อมต่อใหม่", min: 500, max: 30000, unit: "ms" },
] as const;
type NumericField = (typeof numericFields)[number]["key"];
type RealtimeForm = Pick<RealtimeSettingsInput, "realtimeEnabled" | "sseEnabled"> & Record<NumericField, string>;


const toForm = (settings: RealtimeSettings): RealtimeForm => ({
  realtimeEnabled: settings.realtimeEnabled,
  sseEnabled: settings.sseEnabled,
  maxPublicSseConnections: String(settings.maxPublicSseConnections),
  maxStaffSseConnections: String(settings.maxStaffSseConnections),
  heartbeatIntervalMs: String(settings.heartbeatIntervalMs),
  reconnectDelayMs: String(settings.reconnectDelayMs),
});

/**
 * Admin-tunable realtime behaviour (stored in runtime_settings, applied without redeploy).
 * Lowering a cap or disabling SSE only affects NEW connections; open streams stay connected.
 */
export function RealtimeSettingsPanel() {
  const loadRealtimeSettings = useTournamentStore((state) => state.loadRealtimeSettings);
  const updateRealtimeSettings = useTournamentStore((state) => state.updateRealtimeSettings);
  const [settings, setSettings] = useState<RealtimeSettings | null>(null);
  const [form, setForm] = useState<RealtimeForm | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const current = await loadRealtimeSettings();
      setSettings(current);
      setForm((existing) => existing ?? toForm(current));
    } catch { /* surfaced via store.error */ }
  }, [loadRealtimeSettings]);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = async () => {
    if (!form || !settings) return;
    setBusy(true);
    try {
      const saved = await updateRealtimeSettings({
        realtimeEnabled: form.realtimeEnabled,
        sseEnabled: form.sseEnabled,
        maxPublicSseConnections: Number(form.maxPublicSseConnections),
        maxStaffSseConnections: Number(form.maxStaffSseConnections),
        heartbeatIntervalMs: Number(form.heartbeatIntervalMs),
        reconnectDelayMs: Number(form.reconnectDelayMs),
        pollingEnabled: settings.pollingEnabled,
        pollingIntervalMs: settings.pollingIntervalMs,
      });
      setSettings(saved);
      setForm(toForm(saved));
      toast.success("บันทึกแล้ว — มีผลทันทีโดยไม่ต้อง deploy ใหม่");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "บันทึกการตั้งค่าไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const setFlag = (key: "realtimeEnabled" | "sseEnabled") => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => current ? { ...current, [key]: event.target.checked } : current);

  return <section className="panel" id="rt">
    <div className="panel-head"><h2>การตั้งค่าการอัปเดตสด</h2>
      <PrototypeViewerHelp label="การอัปเดตสด">ค่า 0 ปิดการเชื่อมต่อประเภทนั้นได้ ค่าว่างบันทึกไม่ได้</PrototypeViewerHelp></div>
    {!form ? <p className="panel-body meta">กำลังโหลดการตั้งค่า…</p> :
      <form className="panel-body" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="form-row form-row--tight">
          {numericFields.map((field) => <div className="field" key={field.key}>
            <label htmlFor={`rt-${field.key}`}>{field.title}</label>
            <span className="nf"><input className="input nf__in num" id={`rt-${field.key}`} type="number" inputMode="numeric" min={field.min} max={field.max} required
              style={{ width: field.key === "heartbeatIntervalMs" ? 120 : 110 }}
              value={form[field.key]} onChange={(event) => setForm((current) => current ? { ...current, [field.key]: event.target.value } : current)} />
              {"unit" in field && <span className="nf__unit">{field.unit}</span>}</span>
          </div>)}
          <button type="submit" className="btn btn--secondary" disabled={busy}>{busy ? "กำลังบันทึก…" : "บันทึก"}</button>
        </div>
        <details className="prototype-console-details">
          <summary>สถานะและตัวเลือก SSE</summary>
          <div className="form-row form-row--tight">
            <span className="badge badge--info"><RadioTower className="i" size={13} />ผู้ชม {settings?.activePublicStreams ?? 0}</span>
            <span className="badge badge--info"><Activity className="i" size={13} />เจ้าหน้าที่ {settings?.activeStaffStreams ?? 0}</span>
            <label className="checkbox-chip"><input type="checkbox" checked={form.realtimeEnabled} onChange={setFlag("realtimeEnabled")} />เปิดการอัปเดตสด</label>
            <label className="checkbox-chip"><input type="checkbox" checked={form.sseEnabled} onChange={setFlag("sseEnabled")} />เปิด SSE</label>
          </div>
          <p className="meta">การลดเพดานหรือปิด SSE มีผลเฉพาะการเชื่อมต่อใหม่ ค่า 0 ปิดการเชื่อมต่อประเภทนั้น</p>
        </details>
      </form>}
  </section>;
}
