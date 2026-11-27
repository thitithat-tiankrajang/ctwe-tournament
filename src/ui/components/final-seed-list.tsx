"use client";

import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { spectatorPlayerView } from "@/application/tournament/spectator-player";
import { publicDivisionPayload, spectatorDivision } from "@/application/tournament/spectator-read-model";
import type { Player, TournamentCard } from "@/domain/tournament/types";
import { Badge } from "./badge";
import { PrototypeSpectatorPlayer } from "./prototype-spectator-player";

const MOBILE_QUERY = "(max-width: 768px)";
const subscribe = (callback: () => void) => {
  const media = window.matchMedia(MOBILE_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
};

export function FinalSeedList({ card, seeds, canOpenMaster }: { card: TournamentCard; seeds: Player[]; canOpenMaster: boolean }) {
  const mobile = useSyncExternalStore(subscribe, () => window.matchMedia(MOBILE_QUERY).matches, () => false);
  const payload = useMemo(() => publicDivisionPayload(card), [card]);
  const division = useMemo(() => spectatorDivision(payload), [payload]);
  const [opened, setOpened] = useState<string | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const latestGame = division.publication.officialThroughGame;
  const groups = [{ title: "ชิงชนะเลิศ", offset: 0, players: seeds.slice(0, 2) },
    { title: "ชิงอันดับ 3", offset: 2, players: seeds.slice(2, 4) }].filter(group => group.players.length > 0);

  return <><div className="final-seed-groups">
    {groups.map(group => <section className="final-seed-group" aria-label={group.title} key={group.offset}>
      <h3>{group.title}</h3>
      <ol className="final-seed-list" start={group.offset + 1}>
        {group.players.map((player, index) => {
          const game = spectatorPlayerView(payload, division, player.id)?.ledger.find(entry => entry.game === latestGame && entry.state === "official");
          const outcome = game?.outcome === "PENALTY" ? "ลงดาบ" : game?.outcome === "W" ? "ชนะ" : game?.outcome === "L" ? "แพ้" : game?.outcome === "T" ? "เสมอ" : "—";
          const name = <><span className="code">{player.id}</span>{" "}<strong>{player.firstName} {player.lastName}</strong></>;
          return <li className="final-seed-row" key={player.id}>
            <div className="final-seed-identity">
              <Badge tone="info">อันดับ {group.offset + index + 1}</Badge>
              <div className="final-seed-person">
                {canOpenMaster ? <button type="button" className="final-seed-name" aria-haspopup="dialog" title="ดูใบ Master"
                  onClick={event => { anchor.current = event.currentTarget; setOpened(player.id); }}>{name}</button>
                  : <span className="final-seed-name">{name}</span>}
                <small>{player.school}</small>
              </div>
            </div>
            <dl className="final-seed-stats">
              <div><dt>ชนะ–เสมอ–แพ้</dt><dd>{player.wins}–{player.draws}–{player.losses}</dd></div>
              <div><dt>แต้มสะสม</dt><dd>{player.winPoints}</dd></div>
              <div><dt>ผลต่าง</dt><dd>{player.diff > 0 ? "+" : ""}{player.diff}</dd></div>
              <div><dt>เกม {latestGame ?? "ล่าสุด"}</dt><dd>{outcome}{game?.score && game.outcome !== "PENALTY" && <span className="final-seed-score">
                {game.bye ? `บาย ${game.score.own}` : `${game.score.own}–${game.score.opponent}`}
              </span>}</dd></div>
            </dl>
          </li>;
        })}
      </ol>
    </section>)}
    </div>
    {opened && canOpenMaster && <PrototypeSpectatorPlayer card={payload} division={division} code={opened} theme={{}} mobile={mobile}
      anchor={anchor} operational={card} master onOpenPlayer={setOpened}
      onClose={() => { setOpened(null); anchor.current?.focus({ preventScroll: true }); }} />}
  </>;
}
