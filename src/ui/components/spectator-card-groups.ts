/**
 * How the viewer's entrance groups the divisions it offers.
 *
 * Cards are grouped by the card's NAME, which is the game — "A-Math", "Crossword" — and each row
 * inside a group is one division of that game. The rows deliberately print the division alone
 * (UI-R4): repeating the game on every row is noise when the group already says it.
 *
 * That makes the group heading the only place the game is named, which is why the rule for hiding
 * it lives here as a function with tests rather than as a condition inside the JSX. The heading is
 * dropped ONLY when it would reprint the page header verbatim — never on a guess about whether two
 * names mean the same thing.
 */

/** The fields the browse list reads. Structural on purpose: the tests need no domain fixture. */
export interface BrowsableCard {
  name: string;
  division: string;
}

export interface CardGroup<T extends BrowsableCard> {
  /** The card name shared by every card in the group — the game. */
  name: string;
  cards: T[];
  /** Whether the group prints its name above its rows. */
  titled: boolean;
}

/**
 * Two labels are "the same heading" only when they are character-for-character equal once the
 * surrounding whitespace is gone.
 *
 * Nothing fuzzier than that, deliberately. Case folding or punctuation stripping would let
 * "A-Math" hide under a tournament called "A Math", and a spectator who cannot see the game they
 * are looking at has no way to recover — the entrance is the one screen that names it.
 */
function sameHeading(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/**
 * The browse list: one group per card name, sorted by name and then division, each carrying
 * whether it shows its heading.
 *
 * A single group whose name simply repeats the tournament title stays headless, which is the case
 * the original condition was written for. Any other single group DOES print its name: the card
 * name and the tournament name are independent fields, so "Test Screen" containing one "A-Math"
 * left the game unnamed on the entire screen.
 */
export function browseGroups<T extends BrowsableCard>(cards: readonly T[], tournamentName: string): CardGroup<T>[] {
  const grouped = [...cards]
    .sort((a, b) => a.name.localeCompare(b.name, "th", { numeric: true })
      || a.division.localeCompare(b.division, "th", { numeric: true }))
    .reduce<Map<string, T[]>>((groups, card) => {
      const group = groups.get(card.name) ?? [];
      group.push(card);
      groups.set(card.name, group);
      return groups;
    }, new Map());

  const entries = [...grouped.entries()];
  const soleRepeatsHeader = entries.length === 1 && sameHeading(entries[0][0], tournamentName);
  return entries.map(([name, group]) => ({ name, cards: group, titled: !soleRepeatsHeader }));
}
