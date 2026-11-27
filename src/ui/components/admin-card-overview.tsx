"use client";

import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { publicDivisionPayload, spectatorDivision } from "@/application/tournament/spectator-read-model";
import type { TournamentCard } from "@/domain/tournament/types";
import { DocumentDownloadPanel } from "@/ui/components/document-download-panel";
import { prototypeSportTheme } from "@/ui/components/prototype-spectator-chrome";
import { PrototypeSpectatorPlayer } from "@/ui/components/prototype-spectator-player";
import { PrototypeCardReport } from "@/ui/components/prototype-spectator-report";

const MOBILE_QUERY = "(max-width: 768px)";
const subscribe = (callback: () => void) => {
  const media = window.matchMedia(MOBILE_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
};

/**
 * Admin's read-only card overview in the accepted design: sport and division as the page title,
 * the published ranking beside the announced pairings, then documents. Player names open the same
 * anchored participant details the public report uses.
 */
export function AdminCardOverview({ card, allowDownloads }: { card: TournamentCard; allowDownloads: boolean }) {
  const mobile = useSyncExternalStore(subscribe, () => window.matchMedia(MOBILE_QUERY).matches, () => false);
  const payload = useMemo(() => publicDivisionPayload(card), [card]);
  const division = useMemo(() => spectatorDivision(payload), [payload]);
  const [code, setCode] = useState<string | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  return <>
    <div className="page-head"><div className="ttl"><span className="eyebrow">{card.name}</span><h1>{card.division}</h1></div></div>
    <div id="vbody" className="admin-report vbody-host">
      <PrototypeCardReport card={card} division={division} mobile={mobile} onOpen={(player, target) => { anchor.current = target; setCode(player.id); }} />
    </div>
    {allowDownloads && <DocumentDownloadPanel card={card} appearance="prototype-panel" />}
    {code && <PrototypeSpectatorPlayer card={payload} division={division} code={code} theme={prototypeSportTheme(card.name)} mobile={mobile}
      anchor={anchor} onClose={() => { setCode(null); anchor.current?.focus({ preventScroll: true }); }} onOpenPlayer={setCode} />}
  </>;
}
