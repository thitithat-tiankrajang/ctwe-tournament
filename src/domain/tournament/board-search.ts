import { matchesPlayerCode, parseSearchQuery } from "./player-code";

/**
 * Does `row` satisfy a board-level search?
 *
 * One search box covers a whole grid, including fields that occupy more than one column. A pairing
 * row carries two players, so a player code lives in the first OR the second code column depending
 * on seat parity — searching one column at a time is what forced operators to try twice.
 *
 * A code query matches when ANY code column matches ANY token. A text query matches when any
 * searchable column contains it. Both are OR across columns; the caller ANDs the result with the
 * per-column filters, which stay per-column because school and status genuinely are.
 */
export function matchesBoardQuery<T>(
  row: T,
  query: string,
  accessors: Record<string, (row: T) => string | number>,
  playerCodeKeys: readonly string[],
  textKeys: readonly string[],
): boolean {
  const parsed = parseSearchQuery(query);
  if (parsed.kind === "empty") return true;
  if (parsed.kind === "codes")
    return parsed.tokens.some((token) =>
      playerCodeKeys.some((key) => accessors[key] && matchesPlayerCode(accessors[key](row), token)));
  const term = parsed.value.toLocaleLowerCase("th");
  return textKeys.some((key) => accessors[key]
    && String(accessors[key](row)).toLocaleLowerCase("th").includes(term));
}
