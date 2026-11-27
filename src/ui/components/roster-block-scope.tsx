"use client";

import { useId } from "react";
import type { rosterBlockScopes } from "@/domain/tournament/flow";

export function RosterBlockScope({ scopes, game, onChange, action }: {
  scopes: ReturnType<typeof rosterBlockScopes>;
  game?: number;
  onChange: (game: number) => void;
  action: string;
}) {
  const name = useId();
  if (!scopes.length) return null;
  return <fieldset className="roster-scope">
    <legend>เริ่ม{action}เมื่อไหร่</legend>
    {scopes.map((scope) => <label key={scope.game}>
      <input type="radio" name={name} value={scope.game} checked={scope.game === game} onChange={() => onChange(scope.game)} />
      <span><strong>{scope.label}</strong><small>{scope.detail}</small></span>
    </label>)}
  </fieldset>;
}
