/**
 * Sidebar card-folder expansion rule (P5-D21).
 *
 * D21 asks for three things: keep per-card folders, make the current card strongly prominent, and
 * **collapse unused folders**. The first two were already in place — `.card-folder--current` and the
 * "ปัจจุบัน" badge — but expansion only ever grew: opening a card expanded its folder and left every
 * previously opened one expanded too, so after a few cards the sidebar was a wall of pages and the
 * prominence the other two parts bought was diluted by sheer length.
 *
 * Navigating to a card now leaves exactly that card's folder open. Manual toggles are still honoured
 * — the caller applies this on card CHANGE only, so peeking into another folder stays open until you
 * actually go somewhere else.
 */
export function foldersAfterOpening(
  expanded: ReadonlySet<string>,
  cardId: string,
): ReadonlySet<string> {
  // Reference-equal when nothing would change. `app-shell.tsx` is the file P3-E had to restructure
  // to get shell renders per SSE event to zero, so handing back a fresh Set for a no-op would give
  // that work back one render at a time.
  if (expanded.size === 1 && expanded.has(cardId)) return expanded;
  return new Set([cardId]);
}
