-- Player codes gain a per-card letter prefix that is unique WITHIN a tournament: the first card of
-- a tournament is A, the second B, and so on (A..Z, then AA, AB, …). Different tournaments restart
-- at A independently. The number part (001, 002, …) is unchanged, so a code now reads like "A001".
--
-- Existing cards are backfilled (overwritten, never deleted) by creation order within each
-- tournament, matching how new cards will be numbered going forward.

ALTER TABLE tournament_cards ADD COLUMN code_prefix VARCHAR(5);

-- Bijective base-26 of each card's 1-based position in its tournament. Two letters cover 702 cards
-- per tournament — far beyond any real event — and the application generates identical prefixes for
-- new cards, so the two never disagree in practice.
WITH ordered AS (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY tournament_id ORDER BY created_at, id) AS rn
    FROM tournament_cards
)
UPDATE tournament_cards c
SET code_prefix = CASE
    WHEN o.rn <= 26 THEN chr(64 + o.rn::int)
    ELSE chr(64 + ((o.rn - 1) / 26)::int) || chr(65 + ((o.rn - 1) % 26)::int)
END
FROM ordered o
WHERE o.id = c.id;

ALTER TABLE tournament_cards ALTER COLUMN code_prefix SET NOT NULL;
