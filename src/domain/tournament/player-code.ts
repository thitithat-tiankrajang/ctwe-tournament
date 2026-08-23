const PLAYER_CODE_QUERY = /^[A-Za-z]*\d+$/;

/** Split a code into its letter prefix and its numeric part (leading zeros dropped). */
function splitCode(value: string): { letters: string; digits: string } | null {
  const match = value.trim().toUpperCase().match(/^([A-Za-z]*)(\d+)$/);
  return match ? { letters: match[1], digits: match[2].replace(/^0+(?=\d)/, "") } : null;
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

/** Match the backend's numeric code ordering, including four-digit and legacy-prefixed codes. */
export function comparePlayerCodes(first: string | number, second: string | number) {
  const a = splitCode(String(first));
  const b = splitCode(String(second));
  if (!a || !b) return String(first).localeCompare(String(second), "en", { numeric: true });
  const prefix = a.letters.localeCompare(b.letters, "en");
  if (prefix !== 0) return prefix;
  return a.digits.length - b.digits.length || a.digits.localeCompare(b.digits, "en");
}

/**
 * What the operator typed, resolved into the one meaning it can have.
 *
 * A code set only when EVERY whitespace/comma/semicolon-separated token looks like a code —
 * partial splitting would be wrong, because a person's name legitimately contains spaces. So
 * "5 003 45" is four codes and "สมชาย ใจดี" is one text query, with no ambiguous middle ground.
 */
export type SearchQuery =
  | { kind: "empty" }
  | { kind: "codes"; tokens: string[] }
  | { kind: "text"; value: string };

const SEARCH_SEPARATORS = /[\s,;]+/;

/** Parse a search box's raw value. Code tokens are normalized and de-duplicated, order preserved. */
export function parseSearchQuery(input: string): SearchQuery {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "empty" };
  const tokens = trimmed.split(SEARCH_SEPARATORS).filter(Boolean);
  if (tokens.length === 0 || !tokens.every((token) => PLAYER_CODE_QUERY.test(token)))
    return { kind: "text", value: trimmed };
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const token of tokens) {
    const key = normalizePlayerCode(token);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(token);
  }
  return { kind: "codes", tokens: unique };
}

/**
 * Code tokens that match none of `values`. The UI names these back to the operator instead of
 * silently narrowing to nothing — "ไม่พบรหัส 045" is recoverable, an empty board is not.
 */
export function unmatchedCodes(tokens: readonly string[], values: Iterable<string | number>): string[] {
  const candidates = [...values];
  return tokens.filter((token) => !candidates.some((value) => matchesPlayerCode(value, token)));
}

export { PLAYER_CODE_QUERY };
