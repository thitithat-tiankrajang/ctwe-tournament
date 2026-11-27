"use client";

import { useMemo, useState } from "react";
import { selectCardList, useTournamentStore } from "@/application/tournament/store";
import type { Tournament } from "@/domain/tournament/types";
import { prototypeSportTheme } from "./prototype-spectator-chrome";
import { isSportColor, sportColorFor, useSportColorRevision, writeSportColor } from "./sport-colors";

function SportColorRow({ tournamentId, sport }: { tournamentId: string; sport: string }) {
  const color = sportColorFor(tournamentId, sport);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const commit = (value: string) => {
    const next = value.trim();
    if (!isSportColor(next)) { setInvalid(true); return; }
    setInvalid(false);
    setDraft(null);
    writeSportColor(tournamentId, sport, next);
  };
  return <div className="sport-setting sport-theme" style={prototypeSportTheme(sport, color)}>
    <span className="sport-swatch" aria-hidden /><span>{sport}</span>
    <input type="color" aria-label={`เลือกสี ${sport}`} value={color} onChange={(event) => commit(event.target.value)} />
    <input type="text" aria-label={`รหัสสี HEX ${sport}`} value={draft ?? color} maxLength={7} spellCheck={false} autoComplete="off"
      aria-invalid={invalid || undefined} title={invalid ? "กรอกรหัสสี 6 หลัก เช่น #315db3" : undefined}
      onChange={(event) => { setDraft(event.target.value); setInvalid(false); if (isSportColor(event.target.value.trim())) commit(event.target.value); }}
      onBlur={(event) => { if (draft !== null) commit(event.target.value); }}
      onKeyDown={(event) => { if (event.key === "Enter") commit(event.currentTarget.value); if (event.key === "Escape") { setDraft(null); setInvalid(false); } }} />
  </div>;
}

/** Admin's per-tournament sport accents for the public report (saved in this browser). */
export function SportColorsPanel({ tournaments }: { tournaments: Tournament[] }) {
  useSportColorRevision();
  const cards = useTournamentStore((state) => state.cards);
  const summaries = useTournamentStore((state) => state.summaries);
  const sports = useMemo(() => {
    const byTournament = new Map<string, string[]>();
    for (const card of selectCardList(cards, summaries).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const list = byTournament.get(card.tournamentId) ?? [];
      if (!list.includes(card.name)) list.push(card.name);
      byTournament.set(card.tournamentId, list);
    }
    return byTournament;
  }, [cards, summaries]);
  const listed = tournaments.filter((tour) => (sports.get(tour.id)?.length ?? 0) > 0);
  if (listed.length === 0) return null;
  return <section className="panel">
    <div className="panel-head"><h2>สีประจำกีฬาในหน้าผู้ชม</h2></div>
    <div className="panel-body sport-settings">
      {listed.map((tour) => <fieldset className="fs" key={tour.id}><legend>{tour.name}</legend>
        {(sports.get(tour.id) ?? []).map((sport) => <SportColorRow key={sport} tournamentId={tour.id} sport={sport} />)}
      </fieldset>)}
    </div>
  </section>;
}
