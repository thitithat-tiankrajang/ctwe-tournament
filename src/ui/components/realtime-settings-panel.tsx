"use client";

import { Activity, RadioTower, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTournamentStore, type RealtimeSettings, type RealtimeSettingsInput } from "@/application/tournament/store";
import { toast } from "@/application/ui/toast";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { Panel } from "@/ui/components/page";

/** The panel edits only the SSE-relevant subset; polling fields pass through untouched. */
type RealtimeForm = Omit<RealtimeSettingsInput, "pollingEnabled" | "pollingIntervalMs">;

const toForm = (settings: RealtimeSettings): RealtimeForm => ({
  realtimeEnabled: settings.realtimeEnabled,
  sseEnabled: settings.sseEnabled,
  maxPublicSseConnections: settings.maxPublicSseConnections,
  maxStaffSseConnections: settings.maxStaffSseConnections,
  heartbeatIntervalMs: settings.heartbeatIntervalMs,
  reconnectDelayMs: settings.reconnectDelayMs,
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
        ...form,
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

  const setNumber = (key: keyof RealtimeForm) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => current ? { ...current, [key]: Number(event.target.value) } : current);
  const setFlag = (key: keyof RealtimeForm) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => current ? { ...current, [key]: event.target.checked } : current);

  return (
    <Panel
      title="Realtime (SSE only)"
      description="ระบบใช้ SSE เท่านั้นเพื่อลด edge requests · การลดเพดานหรือปิด SSE มีผลเฉพาะการเชื่อมต่อใหม่ และสตรีมที่เปิดอยู่จะไม่หลุด"
    >
      {!form ? (
        <p className="muted panel-padding">กำลังโหลดการตั้งค่า…</p>
      ) : (
        <>
          <div className="panel-padding console-flex">
            <Badge tone="info"><RadioTower size={13} /> SSE ผู้ชมที่เปิดอยู่ {settings?.activePublicStreams ?? 0} / {form.maxPublicSseConnections}</Badge>
            <Badge tone="info"><Activity size={13} /> SSE เจ้าหน้าที่ที่เปิดอยู่ {settings?.activeStaffStreams ?? 0} / {form.maxStaffSseConnections}</Badge>
            {settings?.updatedAt && <span className="console-note">แก้ไขล่าสุด {new Date(settings.updatedAt).toLocaleString("th-TH")}</span>}
          </div>
          <div className="panel-padding panel-padding--flush-top console-flex console-flex--spread">
            <label className="checkbox-chip">
              <input type="checkbox" checked={form.realtimeEnabled} onChange={setFlag("realtimeEnabled")} />
              Realtime Enabled (สวิตช์หลัก)
            </label>
            <label className="checkbox-chip">
              <input type="checkbox" checked={form.sseEnabled} onChange={setFlag("sseEnabled")} />
              SSE Enabled
            </label>
          </div>
          <div className="panel-padding panel-padding--flush-top form-grid">
            <div className="form-field">
              <label className="form-label" htmlFor="rt-max-public">Max SSE Connections — ผู้ชม (0–1500)</label>
              <input className="input input--narrow" id="rt-max-public" type="number" min={0} max={1500}
                value={form.maxPublicSseConnections} onChange={setNumber("maxPublicSseConnections")} />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="rt-max-staff">Max SSE Connections — เจ้าหน้าที่ (0–1000)</label>
              <input className="input input--narrow" id="rt-max-staff" type="number" min={0} max={1000}
                value={form.maxStaffSseConnections} onChange={setNumber("maxStaffSseConnections")} />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="rt-heartbeat">Heartbeat Interval (ms, 5000–120000)</label>
              <input className="input input--narrow" id="rt-heartbeat" type="number" min={5000} max={120000} step={1000}
                value={form.heartbeatIntervalMs} onChange={setNumber("heartbeatIntervalMs")} />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="rt-reconnect">Reconnect Delay (ms, 500–30000)</label>
              <input className="input input--narrow" id="rt-reconnect" type="number" min={500} max={30000} step={100}
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
