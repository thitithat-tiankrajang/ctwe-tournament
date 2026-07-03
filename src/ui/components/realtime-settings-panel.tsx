"use client";

import { Activity, RadioTower, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTournamentStore, type RealtimeSettings, type RealtimeSettingsInput } from "@/application/tournament/store";
import { toast } from "@/application/ui/toast";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { Panel } from "@/ui/components/page";

const numberField: React.CSSProperties = { maxWidth: 160 };

/**
 * Admin-tunable realtime behaviour (stored in runtime_settings, applied without redeploy).
 * Lowering a cap or disabling SSE only affects NEW connections — open streams stay connected
 * and refused browsers fall back to polling automatically.
 */
export function RealtimeSettingsPanel() {
  const loadRealtimeSettings = useTournamentStore((state) => state.loadRealtimeSettings);
  const updateRealtimeSettings = useTournamentStore((state) => state.updateRealtimeSettings);
  const [settings, setSettings] = useState<RealtimeSettings | null>(null);
  const [form, setForm] = useState<RealtimeSettingsInput | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const current = await loadRealtimeSettings();
      setSettings(current);
      setForm((existing) => existing ?? {
        realtimeEnabled: current.realtimeEnabled,
        sseEnabled: current.sseEnabled,
        pollingEnabled: current.pollingEnabled,
        maxPublicSseConnections: current.maxPublicSseConnections,
        maxStaffSseConnections: current.maxStaffSseConnections,
        pollingIntervalMs: current.pollingIntervalMs,
        heartbeatIntervalMs: current.heartbeatIntervalMs,
        reconnectDelayMs: current.reconnectDelayMs,
      });
    } catch { /* surfaced via store.error */ }
  }, [loadRealtimeSettings]);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      const saved = await updateRealtimeSettings(form);
      setSettings(saved);
      setForm({
        realtimeEnabled: saved.realtimeEnabled,
        sseEnabled: saved.sseEnabled,
        pollingEnabled: saved.pollingEnabled,
        maxPublicSseConnections: saved.maxPublicSseConnections,
        maxStaffSseConnections: saved.maxStaffSseConnections,
        pollingIntervalMs: saved.pollingIntervalMs,
        heartbeatIntervalMs: saved.heartbeatIntervalMs,
        reconnectDelayMs: saved.reconnectDelayMs,
      });
      toast.success("บันทึกแล้ว — มีผลทันทีโดยไม่ต้อง deploy ใหม่");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "บันทึกการตั้งค่าไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const setNumber = (key: keyof RealtimeSettingsInput) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => current ? { ...current, [key]: Number(event.target.value) } : current);
  const setFlag = (key: keyof RealtimeSettingsInput) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => current ? { ...current, [key]: event.target.checked } : current);

  return (
    <Panel
      title="Realtime (SSE / Polling)"
      description="ปรับพฤติกรรม realtime ได้ทันทีโดยไม่ต้อง deploy · การลดเพดานหรือปิด SSE มีผลเฉพาะการเชื่อมต่อใหม่ — สตรีมที่เปิดอยู่ไม่หลุด และเบราว์เซอร์ที่ถูกปฏิเสธจะสลับไป polling อัตโนมัติ"
    >
      {!form ? (
        <p className="muted panel-padding">กำลังโหลดการตั้งค่า…</p>
      ) : (
        <>
          <div className="panel-padding" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Badge tone="info"><RadioTower size={13} /> SSE ผู้ชมที่เปิดอยู่ {settings?.activePublicStreams ?? 0} / {form.maxPublicSseConnections}</Badge>
            <Badge tone="info"><Activity size={13} /> SSE เจ้าหน้าที่ที่เปิดอยู่ {settings?.activeStaffStreams ?? 0} / {form.maxStaffSseConnections}</Badge>
            {settings?.updatedAt && <span className="muted" style={{ fontSize: 12 }}>แก้ไขล่าสุด {new Date(settings.updatedAt).toLocaleString("th-TH")}</span>}
          </div>
          <div className="panel-padding" style={{ display: "flex", gap: 18, flexWrap: "wrap", paddingTop: 0 }}>
            <label className="checkbox-chip" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={form.realtimeEnabled} onChange={setFlag("realtimeEnabled")} />
              Realtime Enabled (สวิตช์หลัก)
            </label>
            <label className="checkbox-chip" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={form.sseEnabled} onChange={setFlag("sseEnabled")} />
              SSE Enabled
            </label>
            <label className="checkbox-chip" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={form.pollingEnabled} onChange={setFlag("pollingEnabled")} />
              Polling Enabled
            </label>
          </div>
          <div className="panel-padding form-grid" style={{ paddingTop: 0 }}>
            <div className="form-field">
              <label className="form-label" htmlFor="rt-max-public">Max SSE Connections — ผู้ชม (0–1500)</label>
              <input className="input" id="rt-max-public" type="number" min={0} max={1500} style={numberField}
                value={form.maxPublicSseConnections} onChange={setNumber("maxPublicSseConnections")} />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="rt-max-staff">Max SSE Connections — เจ้าหน้าที่ (0–1000)</label>
              <input className="input" id="rt-max-staff" type="number" min={0} max={1000} style={numberField}
                value={form.maxStaffSseConnections} onChange={setNumber("maxStaffSseConnections")} />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="rt-poll">Polling Interval (ms, 5000–600000)</label>
              <input className="input" id="rt-poll" type="number" min={5000} max={600000} step={1000} style={numberField}
                value={form.pollingIntervalMs} onChange={setNumber("pollingIntervalMs")} />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="rt-heartbeat">Heartbeat Interval (ms, 5000–120000)</label>
              <input className="input" id="rt-heartbeat" type="number" min={5000} max={120000} step={1000} style={numberField}
                value={form.heartbeatIntervalMs} onChange={setNumber("heartbeatIntervalMs")} />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="rt-reconnect">Reconnect Delay (ms, 500–30000)</label>
              <input className="input" id="rt-reconnect" type="number" min={500} max={30000} step={100} style={numberField}
                value={form.reconnectDelayMs} onChange={setNumber("reconnectDelayMs")} />
            </div>
          </div>
          <div className="form-actions">
            <Button disabled={busy} onClick={() => void save()}><Save size={16} />{busy ? "กำลังบันทึก…" : "บันทึกการตั้งค่า"}</Button>
          </div>
        </>
      )}
    </Panel>
  );
}
