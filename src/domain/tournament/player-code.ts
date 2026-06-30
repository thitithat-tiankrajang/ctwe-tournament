const PLAYER_CODE_QUERY = /^P?\d+$/i;

/** Accepts `16`, `016`, or `P016` and returns the canonical three-digit player code. */
export function normalizePlayerCode(value: string) {
  const trimmed = value.trim().toUpperCase();
  if (!PLAYER_CODE_QUERY.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/^P/i, "").replace(/^0+(?=\d)/, "");
  return `P${digits.padStart(3, "0")}`;
}

/** Numeric player-code searches are exact: `1` matches P001, never P011/P021. */
export function matchesPlayerCode(value: string | number, query: string) {
  const term = query.trim();
  if (!term) return true;
  const candidate = String(value).trim().toUpperCase();
  return PLAYER_CODE_QUERY.test(term)
    ? normalizePlayerCode(candidate) === normalizePlayerCode(term)
    : candidate.includes(term.toUpperCase());
}
