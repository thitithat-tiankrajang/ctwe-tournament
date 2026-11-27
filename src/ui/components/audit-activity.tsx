"use client";

import { ArrowRight, ChevronDown, FileClock, FilePlus2, Filter, Globe, ListChecks, Pencil, Save, Shuffle, Swords, Undo2, Upload, UserCheck, UserMinus, UserPlus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import type { AuditEntry } from "@/domain/tournament/types";
import { SelectMenu } from "@/ui/components/select-menu";

const labels: Record<string, string> = {
  CREATE_CARD: "สร้างรุ่นการแข่งขัน", ADD_PLAYER: "เพิ่มผู้เล่น", IMPORT_PLAYERS: "นำเข้ารายชื่อ",
  UPDATE_PLAYER: "แก้ข้อมูลผู้เล่น", REMOVE_PLAYER: "ลบผู้เล่น", TERMINATE_PLAYERS: "ถอนผู้เล่น", RESTORE_PLAYERS: "ดึงผู้เล่นกลับ",
  FINISH_PLAYER_REGISTRATION: "จบการลงทะเบียน", REOPEN_REGISTRATION: "เปิดลงทะเบียนเพิ่ม",
  GENERATE_PAIRING_PREVIEW: "สร้างคู่แข่งขัน", CONFIRM_PAIRING: "ยืนยันคู่แข่งขัน", UNDO_PAIRING: "ยกเลิกร่างคู่แข่งขัน",
  UNPAIR_PAIRING: "ยกเลิกคู่แข่งขัน", SWAP_PLAYERS: "สลับผู้เล่น", PAIRING_COMMIT: "ปรับคู่แข่งขัน",
  SUBMIT_RESULT: "บันทึกผล", EDIT_RESULT: "แก้ไขผล", OVERRIDE_RESULT: "แก้ไขผลย้อนหลัง", PENALTY_RESULT: "ลงดาบ",
  REVOKE_PENALTY: "ถอนดาบ", REVIEW_RESULTS: "ตรวจผล", REOPEN_RESULTS: "เปิดแก้ผล",
  PUBLISH_GAME_RESULTS: "เผยแพร่ผล", PUBLISH_FINAL_RESULTS: "เผยแพร่ผลรอบสุดท้าย",
  START_FINAL: "เริ่มรอบชิง", FINAL_RESULT: "บันทึกผลรอบชิง", FINAL_WINNER: "สรุปผู้ชนะ", PUBLISH_FINAL: "เผยแพร่รอบชิง", CLOSE_CARD: "ปิดการ์ด",
  CANCEL_FINAL: "ยกเลิกการล็อกผู้เข้าชิง",
  FINISH_WITH_REGULAR_RESULTS: "จบด้วยอันดับรอบปกติ",
};
const date = new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short" });
const time = new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function objectValue(value: string): Record<string, unknown> | undefined {
  if (typeof value !== "string" || !value.startsWith("{")) return;
  try {
    const data: unknown = JSON.parse(value);
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch { /* Legacy values can be plain text. */ }
}

function matchLocation(entry: AuditEntry) {
  const before = objectValue(entry.oldValue);
  const after = objectValue(entry.newValue);
  const id = before?.matchId ?? after?.matchId;
  const match = typeof id === "string" ? /^g(\d+)t(\d+)$/.exec(id) : null;
  if (match) return { game: Number(match[1]), table: Number(match[2]) };
  const game = after?.game;
  const table = after?.table;
  return { game: typeof game === "number" ? game : null, table: typeof table === "number" ? table : null };
}

export function groupScoreSubmissions(entries: AuditEntry[]): AuditEntry[][] {
  const groups: AuditEntry[][] = [];
  for (const entry of [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp))) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    const game = entry.action === "SUBMIT_RESULT" ? matchLocation(entry).game : null;
    if (previous && game != null && previous.action === entry.action && previous.user === entry.user &&
        game === matchLocation(previous).game && Date.parse(previous.timestamp) - Date.parse(entry.timestamp) <= 120_000) {
      group?.push(entry);
    } else groups.push([entry]);
  }
  return groups;
}

const ruleNames: Record<string, string> = { RANDOM: "Random", SWISS: "Swiss", PAIR_RESULT: "สลับในโต๊ะตามผล", KING_OF_THE_HILL: "King of the Hill" };
const fieldNames: Record<string, string> = {
  game: "เกม", players: "ผู้เล่น", count: "จำนวน", rule: "กติกา", name: "ชื่อ", division: "รุ่น", school: "โรงเรียน",
  firstName: "ชื่อ", lastName: "นามสกุล", reason: "เหตุผล", table: "คู่", username: "บัญชี",
};

function formatValue(value: string) {
  const parsed = objectValue(value);
  if (!parsed) return value && value !== "—" ? value : "";
  if (parsed.status === "UNRECORDED") return "";
  if (typeof parsed.scoreOne === "number" && typeof parsed.scoreTwo === "number") return `${parsed.scoreOne} : ${parsed.scoreTwo}`;
  return Object.entries(parsed).filter(([, field]) => field !== null && field !== undefined && field !== "")
    .map(([key, field]) => `${fieldNames[key] ?? key} ${Array.isArray(field) ? field.join(", ") : typeof field === "object" ? JSON.stringify(field) : String(field)}`)
    .join(" · ");
}

const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

/** The change column in the accepted design's words: a scope ("เกม 4") and a short before → after. */
function describe(entry: AuditEntry): { scope: string | null; before: string; after: string } {
  const before = objectValue(entry.oldValue);
  const after = objectValue(entry.newValue);
  const location = matchLocation(entry);
  const scope = location.game != null ? `เกม ${location.game}${location.table != null ? ` · คู่ ${location.table}` : ""}` : null;
  switch (entry.action) {
    case "CONFIRM_PAIRING": {
      const game = num(after?.publishedPairingGame) ?? (Array.isArray(after?.resultCollectionGames) ? num(after.resultCollectionGames.at(-1)) : null);
      const tables = num(after?.tableCount) ?? num(after?.tables);
      return { scope: game != null ? `เกม ${game}` : null, before: "", after: tables != null ? `${tables} คู่` : "" };
    }
    case "GENERATE_PAIRING_PREVIEW": {
      const game = num(after?.game);
      const rule = typeof after?.rule === "string" ? ruleNames[after.rule] ?? after.rule : "";
      const players = num(after?.players);
      return { scope: game != null ? `เกม ${game}` : null, before: "", after: [rule, players != null ? `${players} คน` : ""].filter(Boolean).join(" · ") };
    }
    case "FINISH_PLAYER_REGISTRATION": {
      const count = /^(\d+)\s+players?/.exec(entry.oldValue ?? "")?.[1];
      return { scope: null, before: "", after: count ? `ลงทะเบียน ${count} คน` : formatValue(entry.newValue) };
    }
    case "IMPORT_PLAYERS": {
      const count = num(after?.count);
      return { scope: null, before: "", after: count != null ? `${count} คน` : formatValue(entry.newValue) };
    }
    case "CREATE_CARD": {
      const games = Array.isArray(after?.gameMaxDiffs) ? after.gameMaxDiffs.length : null;
      const parts = [after?.name, after?.division].filter((part): part is string => typeof part === "string" && part.length > 0);
      return { scope: null, before: "", after: [parts.join(" · "), games ? `${games} เกม` : ""].filter(Boolean).join(" · ") };
    }
    case "PUBLISH_GAME_RESULTS": case "REVIEW_RESULTS": case "REOPEN_RESULTS": {
      const game = num(after?.game) ?? num(after?.gameNumber) ?? location.game;
      return { scope: game != null ? `เกม ${game}` : null, before: "", after: "" };
    }
    case "CANCEL_FINAL": {
      const pairings = Array.isArray(before?.pairings) ? before.pairings : [];
      const pairs = pairings.filter(pair => Array.isArray(pair?.players))
        .map(pair => `${pair.slot === 0 ? "ชิงชนะเลิศ" : "ชิงอันดับ 3"} ${pair.players.join(" – ")}`);
      return { scope: "รอบชิง", before: pairs.join(" · "), after: formatValue(entry.newValue) };
    }
    default: return { scope, before: formatValue(entry.oldValue), after: formatValue(entry.newValue) };
  }
}

const actionIcons: Record<string, { icon: typeof Save; tone: string }> = {
  SUBMIT_RESULT: { icon: Save, tone: "score" },
  EDIT_RESULT: { icon: Pencil, tone: "edit" },
  OVERRIDE_RESULT: { icon: Pencil, tone: "edit" },
  PENALTY_RESULT: { icon: Swords, tone: "edit" },
  REVOKE_PENALTY: { icon: Swords, tone: "edit" },
  CONFIRM_PAIRING: { icon: Users, tone: "pair" },
  GENERATE_PAIRING_PREVIEW: { icon: Shuffle, tone: "pair" },
  PAIRING_COMMIT: { icon: Shuffle, tone: "pair" },
  SWAP_PLAYERS: { icon: Shuffle, tone: "pair" },
  ADD_PLAYER: { icon: UserPlus, tone: "roster" },
  IMPORT_PLAYERS: { icon: UserPlus, tone: "roster" },
  UPDATE_PLAYER: { icon: Pencil, tone: "roster" },
  REMOVE_PLAYER: { icon: UserMinus, tone: "roster" },
  TERMINATE_PLAYERS: { icon: UserMinus, tone: "roster" },
  RESTORE_PLAYERS: { icon: UserCheck, tone: "roster" },
  FINISH_PLAYER_REGISTRATION: { icon: UserCheck, tone: "roster" },
  REOPEN_REGISTRATION: { icon: UserPlus, tone: "roster" },
  CREATE_CARD: { icon: FilePlus2, tone: "neutral" },
  REVIEW_RESULTS: { icon: ListChecks, tone: "score" },
  PUBLISH_GAME_RESULTS: { icon: Globe, tone: "publish" },
  PUBLISH_FINAL_RESULTS: { icon: Globe, tone: "publish" },
  PUBLISH_FINAL: { icon: Upload, tone: "publish" },
  CANCEL_FINAL: { icon: Undo2, tone: "pair" },
  FINISH_WITH_REGULAR_RESULTS: { icon: Upload, tone: "publish" },
};

function Timestamp({ value, compact = false }: { value: string; compact?: boolean }) {
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf())) return <span>—</span>;
  return compact
    ? <time dateTime={value}>{time.format(instant)}</time>
    : <time className="audit-at" dateTime={value}><strong>{time.format(instant)}</strong><small>{date.format(instant)}</small></time>;
}

export function AuditActivity({ entries }: { entries: AuditEntry[] }) {
  const [filter, setFilter] = useState("all");
  const groups = useMemo(() => groupScoreSubmissions(entries), [entries]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of entries) map.set(entry.action, (map.get(entry.action) ?? 0) + 1);
    return map;
  }, [entries]);
  const selected = filter === "all" || !counts.has(filter) ? "all" : filter;
  const options = [{ value: "all", label: "ทุกกิจกรรม", detail: String(entries.length) }, ...[...counts].map(([value, count]) => ({ value, label: labels[value] ?? value, detail: String(count) }))];
  const visible = groups.filter(([entry]) => selected === "all" || entry.action === selected);

  return <section className="panel audit-panel" aria-label="บันทึกกิจกรรม">
    <div className="audit-toolbar"><span role="status"><strong>{selected === "all" ? entries.length : `${counts.get(selected)} จาก ${entries.length}`}</strong> รายการ<span className="audit-sort"> · ล่าสุดก่อน</span></span>
      <SelectMenu appearance="prototype" value={selected} options={options} onChange={setFilter} ariaLabel="ชนิดกิจกรรม" icon={Filter} />
    </div>
    <div className="audit-column-head" aria-hidden="true"><span>เวลา</span><span>ผู้ใช้</span><span>กิจกรรม</span><span>การเปลี่ยนแปลง</span></div>
    {visible.length ? <ol className="audit-list">{visible.map((group) => {
      const [first] = group;
      const { game } = matchLocation(first);
      const { scope, before, after } = describe(first);
      const label = labels[first.action] ?? first.action;
      const { icon: Icon, tone } = actionIcons[first.action] ?? { icon: FileClock, tone: "neutral" };
      const metadata = <><Timestamp value={first.timestamp} /><span className="audit-actor">{first.user}</span>
        <span className="audit-activity"><span className="audit-icon" data-tone={tone}><Icon className="i" size={15} /></span><strong>{label}</strong></span></>;
      if (group.length === 1) return <li key={first.id} className="audit-event"><div className="audit-row">{metadata}
        <span className="audit-change">{scope && <span className="audit-scope">{scope}</span>}
          {before && <span className="audit-old">{before}</span>}{before && after && <ArrowRight className="i" size={13} />}{after && <strong>{after}</strong>}</span>
      </div></li>;
      return <li key={first.id} className="audit-event"><details className="audit-burst">
        <summary className="audit-row">{metadata}<span className="audit-change"><span className="audit-scope">เกม {game}</span>
          <span className="audit-badge">{group.length} รายการ</span><span className="audit-arrow" aria-hidden><ChevronDown className="i" size={15} /></span></span></summary>
        <ul className="audit-burst-list" aria-label="รายละเอียดการบันทึกผล">{group.map((entry) => {
          const location = matchLocation(entry);
          return <li key={entry.id}><Timestamp value={entry.timestamp} compact /><span>{location.table != null ? `คู่ ${location.table}` : "—"}</span><strong>{formatValue(entry.newValue)}</strong></li>;
        })}</ul>
      </details></li>;
    })}</ol> : <p className="audit-empty">{entries.length ? "ไม่พบกิจกรรมชนิดนี้" : "ยังไม่มีบันทึกกิจกรรม"}</p>}
  </section>;
}
