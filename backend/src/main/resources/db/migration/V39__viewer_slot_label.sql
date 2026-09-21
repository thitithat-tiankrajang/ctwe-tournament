-- How the public reports name a slot: by its PAIR number, or by the two SEAT numbers it holds.
--
-- Both numbers describe the same thing from opposite ends — pair n holds seats 2n-1 and 2n — and
-- which one an event announces over the microphone is a decision each organiser makes once, for the
-- whole card. Carrying both in the viewer spent a column of a 375px phone on a number half the room
-- was not using, so the card now says which one its audience reads and the viewer shows only that.
--
-- Additive only. Existing cards default to PAIR, which is how every report has been organised since
-- the first one: rows are pairs, and the seat numbers were the derived column.
ALTER TABLE tournament_cards
    ADD COLUMN slot_label VARCHAR(8) NOT NULL DEFAULT 'PAIR'
        CHECK (slot_label IN ('PAIR', 'SEAT'));
