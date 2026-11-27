"use client";

import { ChevronRight, Search, UserRoundSearch, X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import {
  divisionOptions,
  schoolOptions,
  searchParticipants,
  SPECTATOR_SEARCH_LIMIT,
  type SpectatorSearchCriteria,
  type SpectatorSearchResult,
} from "@/application/tournament/spectator-search";
import type { SpectatorDivision } from "@/application/tournament/spectator-read-model";
import { EmptyState } from "@/ui/components/page";

/**
 * The Find path of the public entrance: a spectator arriving on a tournament QR code types their own
 * player code and goes straight to their participation.
 *
 * Searching is event-wide by design — being made to pick a division first is the step that fails
 * when somebody does not know which division they were entered in. Division and institution are
 * offered as OPTIONAL narrowing, and only once there is something to narrow.
 */
export function SpectatorFind({ divisions, criteria, onCriteriaChange, onOpenPlayer, onSubmit, browse, hideSearch = false, hasReportResults = false }: {
  divisions: SpectatorDivision[];
  criteria: SpectatorSearchCriteria;
  onCriteriaChange: (criteria: SpectatorSearchCriteria) => void;
  onOpenPlayer: (result: SpectatorSearchResult) => void;
  /** Enter / the search key. Jumping straight to a player happens HERE, never while typing. */
  onSubmit: () => void;
  browse: ReactNode;
  hideSearch?: boolean;
  hasReportResults?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const outcome = searchParticipants(divisions, criteria);
  const searching = outcome.kind !== "empty";
  const schools = schoolOptions(divisions, criteria.divisionId);
  const filtersVisible = searching || criteria.divisionId !== null || criteria.school !== null;
  const filtered = criteria.divisionId !== null || criteria.school !== null;

  // Deliberately NOT auto-focused on Back: the query is restored visibly, and stealing focus would
  // raise the phone keyboard over the results the spectator came back to read.

  // A school that the newly chosen division does not contain would filter every row away with no
  // visible cause, so the narrower selection is dropped with the wider one.
  const changeDivision = (divisionId: string | null) => {
    const allowed = criteria.school && schoolOptions(divisions, divisionId).includes(criteria.school);
    onCriteriaChange({ ...criteria, divisionId, school: allowed ? criteria.school : null });
  };

  return (
    <>
      {!hideSearch && <form className="spectator-find" role="search"
        onSubmit={(event) => { event.preventDefault(); inputRef.current?.blur(); onSubmit(); }}>
        <div className="spectator-find__field">
          <Search size={18} aria-hidden />
          <input
            ref={inputRef}
            className="input spectator-find__input"
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            aria-label="ค้นหาด้วยรหัสนักกีฬา หรือ ชื่อ-นามสกุล"
            placeholder="รหัสนักกีฬา หรือ ชื่อ-นามสกุล"
            value={criteria.query}
            onChange={(event) => onCriteriaChange({ ...criteria, query: event.target.value })}
          />
          {criteria.query !== "" && (
            <button type="button" className="spectator-find__clear" aria-label="ล้างคำค้นหา"
              onClick={() => { onCriteriaChange({ ...criteria, query: "" }); inputRef.current?.focus(); }}>
              <X size={16} aria-hidden />
            </button>
          )}
        </div>

        {filtersVisible && (
          <div className="spectator-find__filters">
            <label className="spectator-find__filter">
              <span>รุ่น</span>
              <select className="select" value={criteria.divisionId ?? ""}
                onChange={(event) => changeDivision(event.target.value || null)}>
                <option value="">ทุกรุ่น</option>
                {divisionOptions(divisions).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="spectator-find__filter">
              <span>โรงเรียน/สถาบัน</span>
              <select className="select" value={criteria.school ?? ""}
                onChange={(event) => onCriteriaChange({ ...criteria, school: event.target.value || null })}>
                <option value="">ทุกโรงเรียน/สถาบัน</option>
                {schools.map((school) => <option key={school} value={school}>{school}</option>)}
              </select>
            </label>
          </div>
        )}
      </form>}

      {!searching && (filtered ? (
        <p className="spectator-find__hint" role="status">ค้นหารหัสหรือชื่อในตัวกรองที่เลือก</p>
      ) : browse)}

      {searching && (outcome.total === 0 ? !hasReportResults && (
        <div className="panel">
          <EmptyState
            icon={<UserRoundSearch size={25} />}
            title={outcome.kind === "code" ? `ไม่พบรหัส ${criteria.query.trim().toUpperCase()}` : "ไม่พบนักกีฬาที่ตรงกับคำค้นหา"}
            description={filtered
              ? "ลองล้างตัวกรองรุ่นหรือโรงเรียน/สถาบัน แล้วค้นหาอีกครั้ง"
              : "ตรวจสอบรหัสหรือชื่ออีกครั้ง — รายชื่อจะปรากฏเมื่อผู้จัดเผยแพร่รุ่นการแข่งขันแล้ว"}
          />
        </div>
      ) : (
        <section className="spectator-results" aria-label="ผลการค้นหานักกีฬา">
          <p className="spectator-results__count" role="status">
            พบ {outcome.total} คน{outcome.total > outcome.results.length ? ` · แสดง ${SPECTATOR_SEARCH_LIMIT} คนแรก` : ""}
          </p>
          <ul className="spectator-results__list">
            {outcome.results.map((result) => (
              <li key={result.key}>
                <button type="button" className="spectator-result" onClick={() => onOpenPlayer(result)}>
                  <span className="spectator-result__code">{result.code}</span>
                  <span className="spectator-result__identity">
                    <span className="spectator-result__name">{result.name}</span>
                    <span className="spectator-result__meta">{result.school || "—"} · {result.divisionLabel}</span>
                  </span>
                  <ChevronRight size={18} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
