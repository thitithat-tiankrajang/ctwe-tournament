"use client";

import { LoaderCircle, Upload } from "lucide-react";
import { useState } from "react";
import { Button } from "@/ui/components/button";
import { Panel } from "@/ui/components/page";

type PlayerRow = { firstName: string; lastName: string; school: string };

/**
 * Bulk add players during registration by reading single-column ranges from an Excel file
 * (e.g. ชื่อ F1:F80, นามสกุล Q1:Q80, โรงเรียน I11:I90) and zipping them top-to-bottom. It only ADDS
 * the players (persisted) — the user still reviews the list and finishes registration themselves.
 */
export function ExcelPlayerImport({ onImport }: { onImport: (players: PlayerRow[]) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [firstRange, setFirstRange] = useState("");
  const [lastRange, setLastRange] = useState("");
  const [schoolRange, setSchoolRange] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const run = async () => {
    setError(""); setInfo("");
    if (!file) { setError("กรุณาเลือกไฟล์ Excel ก่อน"); return; }
    if (!firstRange.trim() || !lastRange.trim() || !schoolRange.trim()) { setError("กรุณากรอกช่วง (range) ให้ครบทั้ง 3 ช่อง"); return; }
    setBusy(true);
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error("อ่านชีตแรกของไฟล์ไม่ได้");

      // Read one single-column range top-to-bottom; reject ranges that span multiple columns.
      const readColumn = (a1: string, label: string): string[] => {
        let range;
        try { range = XLSX.utils.decode_range(a1.trim()); } catch { throw new Error(`ช่วงของ "${label}" ไม่ถูกต้อง (เช่น F1:F80)`); }
        if (range.s.c !== range.e.c) throw new Error(`"${label}" ต้องเป็นคอลัมน์เดียว — พบหลายคอลัมน์ (${a1})`);
        const values: string[] = [];
        for (let row = Math.min(range.s.r, range.e.r); row <= Math.max(range.s.r, range.e.r); row++) {
          const cell = sheet[XLSX.utils.encode_cell({ c: range.s.c, r: row })];
          values.push(cell == null ? "" : String(cell.w ?? cell.v ?? "").trim());
        }
        return values;
      };

      const firsts = readColumn(firstRange, "ชื่อ");
      const lasts = readColumn(lastRange, "นามสกุล");
      const schools = readColumn(schoolRange, "โรงเรียน/สถาบัน");
      if (!(firsts.length === lasts.length && lasts.length === schools.length))
        throw new Error(`จำนวน record ไม่เท่ากัน — ชื่อ ${firsts.length}, นามสกุล ${lasts.length}, โรงเรียน ${schools.length} แถว`);

      const rows: PlayerRow[] = firsts.map((firstName, index) => ({ firstName, lastName: lasts[index], school: schools[index] }));
      const nonEmpty = rows.filter((row) => row.firstName || row.lastName || row.school);
      if (nonEmpty.length === 0) throw new Error("ไม่พบข้อมูลในช่วงที่ระบุ");
      const incomplete = nonEmpty.findIndex((row) => !row.firstName || !row.lastName || !row.school);
      if (incomplete >= 0) throw new Error(`มีแถวที่ข้อมูลไม่ครบ (แถวที่ ${incomplete + 1}) — แต่ละแถวต้องมีครบทั้ง ชื่อ/นามสกุล/โรงเรียน`);

      await onImport(nonEmpty);
      setInfo(`เพิ่มผู้เล่นจากไฟล์ ${nonEmpty.length} คนแล้ว — ตรวจสอบในตารางด้านล่าง แล้วกดจบการลงทะเบียนเมื่อพร้อม (ระบบยังไม่ปิดรับ)`);
      setFile(null); setFirstRange(""); setLastRange(""); setSchoolRange("");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "นำเข้าไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="นำเข้าผู้เล่นจาก Excel" description="อัปโหลดไฟล์แล้วระบุช่วง (range) ของแต่ละข้อมูล เช่น ชื่อ F1:F80 · นามสกุล Q1:Q80 · โรงเรียน I11:I90 — แต่ละช่วงต้องเป็นคอลัมน์เดียวและจำนวนแถวเท่ากัน">
      <div className="panel-padding">
        <div className="form-grid">
          <div className="form-field" style={{ gridColumn: "1 / -1" }}>
            <label className="form-label" htmlFor="xlsx-file">ไฟล์ Excel (.xlsx / .xls / .csv)</label>
            <input id="xlsx-file" type="file" accept=".xlsx,.xls,.csv" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(""); setInfo(""); }} />
          </div>
          <div className="form-field"><label className="form-label" htmlFor="r-first">ช่วงของ ชื่อ</label><input id="r-first" className="input" placeholder="เช่น F1:F80" value={firstRange} disabled={busy} onChange={(event) => setFirstRange(event.target.value.toUpperCase())} /></div>
          <div className="form-field"><label className="form-label" htmlFor="r-last">ช่วงของ นามสกุล</label><input id="r-last" className="input" placeholder="เช่น Q1:Q80" value={lastRange} disabled={busy} onChange={(event) => setLastRange(event.target.value.toUpperCase())} /></div>
          <div className="form-field"><label className="form-label" htmlFor="r-school">ช่วงของ โรงเรียน/สถาบัน</label><input id="r-school" className="input" placeholder="เช่น I11:I90" value={schoolRange} disabled={busy} onChange={(event) => setSchoolRange(event.target.value.toUpperCase())} /></div>
        </div>
        {error && <p className="form-error" style={{ marginTop: 8 }}>{error}</p>}
        {info && <div className="notice notice--info" style={{ marginTop: 10 }}><p><span>{info}</span></p></div>}
        <div className="form-actions" style={{ paddingLeft: 0 }}>
          <Button disabled={busy || !file} onClick={() => void run()}>{busy ? <LoaderCircle className="loading-spinner" size={16} /> : <Upload size={16} />}{busy ? "กำลังนำเข้า…" : "สร้างผู้เล่นจากไฟล์"}</Button>
        </div>
      </div>
    </Panel>
  );
}
