package com.ctwe.tournament.application;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The per-card code prefix sequence: A..Z then AA, AB, … (bijective base-26), capped at 5 letters. */
class CardCodePrefixTest {

    @Test
    void firstTwentySixIndexesAreSingleLetters() {
        assertThat(TournamentCardService.columnLetter(0)).isEqualTo("A");
        assertThat(TournamentCardService.columnLetter(1)).isEqualTo("B");
        assertThat(TournamentCardService.columnLetter(2)).isEqualTo("C");
        assertThat(TournamentCardService.columnLetter(25)).isEqualTo("Z");
    }

    @Test
    void twentySeventhIndexRollsOverToTwoLetters() {
        assertThat(TournamentCardService.columnLetter(26)).isEqualTo("AA");
        assertThat(TournamentCardService.columnLetter(27)).isEqualTo("AB");
        assertThat(TournamentCardService.columnLetter(51)).isEqualTo("AZ");
        assertThat(TournamentCardService.columnLetter(52)).isEqualTo("BA");
        assertThat(TournamentCardService.columnLetter(701)).isEqualTo("ZZ");
        assertThat(TournamentCardService.columnLetter(702)).isEqualTo("AAA");
    }

    @Test
    void rejectsNegativeAndOverfiveLetterIndexes() {
        assertThatThrownBy(() -> TournamentCardService.columnLetter(-1)).isInstanceOf(IllegalArgumentException.class);
        // 26 + 26^2 + 26^3 + 26^4 + 26^5 - 1 is the last 5-letter index; one past it must throw.
        assertThatThrownBy(() -> TournamentCardService.columnLetter(12_356_630)).isInstanceOf(IllegalArgumentException.class);
    }
}
