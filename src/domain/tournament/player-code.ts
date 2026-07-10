const PLAYER_CODE_QUERY = /^[A-Za-z]*\d+$/;

/** Split a code into its letter prefix and its numeric part (leading zeros dropped). */
function splitCode(value: string): { letters: string; digits: string } | null {
  const match = value.trim().toUpperCase().match(/^([A-Za-z]*)(\d+)$/);
  return match ? { letters: match[1], digits: String(Number(match[2])) } : null;
}

/** Accepts `16`, `016`, `A16`, or the legacy `P016`; returns the code with a three-digit number. */
export function normalizePlayerCode(value: string) {
  const parts = splitCode(value);
  if (!parts) return value.trim().toUpperCase();
  return `${parts.letters}${parts.digits.padStart(3, "0")}`;
}

/**
 * Numeric player-code searches are exact: `1` matches A001 / P001, never A011. A letter in the
 * query (e.g. `A1`) additionally constrains the prefix; every player in one card shares a prefix,
 * so a bare number is the usual, sufficient search.
 */
export function matchesPlayerCode(value: string | number, query: string) {
  const term = query.trim();
  if (!term) return true;
  const q = splitCode(term);
  const candidate = splitCode(String(value));
  if (!q || !candidate) return String(value).trim().toUpperCase().includes(term.toUpperCase());
  if (q.letters && q.letters !== candidate.letters) return false;
  return q.digits === candidate.digits;
}

export { PLAYER_CODE_QUERY };
