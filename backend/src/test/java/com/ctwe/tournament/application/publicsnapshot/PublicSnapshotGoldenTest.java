package com.ctwe.tournament.application.publicsnapshot;

import com.ctwe.tournament.application.TournamentCardService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * Golden test for the generated artifact.
 *
 * <p>A published snapshot is permanent and public, so the exact bytes are the contract. This pins them
 * for a fixture tournament that spans every projection branch: any change to the projection, to the
 * payload shape, or to the canonical serializer must show up here as a reviewable diff rather than as
 * a surprise in a file that can never be recalled.
 *
 * <p>The checksum is asserted separately and literally. If someone regenerates the golden document
 * without thinking, the checksum line still forces them to look at what changed.
 *
 * <p>On mismatch the generated document is written to {@code target/public-snapshot-actual.json}.
 */
class PublicSnapshotGoldenTest {
    private static final Path GOLDEN = Path.of("src/test/resources/golden/public-snapshot-payload.json");
    private static final Path ACTUAL = Path.of("target/public-snapshot-actual.json");

    /**
     * Fingerprint of the golden payload. Changing this is a deliberate act, never a merge artifact.
     *
     * <p>Repinned twice for the Screening Pool. First for V37: {@code PairingResponse} gained
     * {@code voided} and {@code resultWithdrawn}. Then for the staff card gaining
     * {@code screeningPool}. Each regenerated golden was audited as purely additive, with no line
     * removed and no existing value changed.
     *
     * <p>The fixture now feeds a NON-EMPTY pool and the golden records an empty one, so this file
     * pins the stripping itself. A published snapshot is permanent — a hold that leaked into one
     * could never be withdrawn from the record.
     *
     * <p>Repinned again for V39: the card gained {@code slotLabel}, saying whether its public reports
     * name a slot by pair or by seat. The regenerated golden was audited line by line — four added
     * {@code "slotLabel" : "PAIR"} lines and nothing else; no line removed, no existing value changed.
     */
    private static final String EXPECTED_CHECKSUM =
        "sha256-465fe3e923a3371644db16d43286618c40f4ec90cc4fd3126a64770b1cc574f9";

    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final TournamentCardService cards = mock(TournamentCardService.class);

    @Test
    @DisplayName("the generated artifact matches the committed golden document")
    void matchesGolden() {
        SnapshotFixtures.stubDefault(jdbc, cards);
        PublicSnapshotArtifact artifact = new PublicSnapshotBuilder(jdbc, cards).build(SnapshotFixtures.TOURNAMENT_ID);
        write(ACTUAL, artifact.payloadJson());

        assertThat(Files.exists(GOLDEN))
            .as("Golden file missing. Review %s and copy it to %s once it is correct.", ACTUAL, GOLDEN)
            .isTrue();
        assertThat(artifact.payloadJson())
            .as("The Public Snapshot payload changed. These bytes are what would be published "
                + "permanently — review the diff against %s line by line.", ACTUAL)
            .isEqualTo(read(GOLDEN));
    }

    @Test
    @DisplayName("the golden payload's checksum is stable")
    void checksumIsPinned() {
        SnapshotFixtures.stubDefault(jdbc, cards);
        PublicSnapshotArtifact artifact = new PublicSnapshotBuilder(jdbc, cards).build(SnapshotFixtures.TOURNAMENT_ID);

        assertThat(artifact.checksum())
            .as("A different checksum means the canonical serializer or the payload changed. "
                + "Phase B verifies published objects with exactly this value.")
            .isEqualTo(EXPECTED_CHECKSUM);
        assertThat(artifact.payloadBytes()).isEqualTo(SnapshotJson.byteLength(artifact.payloadJson()));
    }

    private static void write(Path path, String content) {
        try {
            Files.createDirectories(path.getParent());
            Files.writeString(path, content, StandardCharsets.UTF_8);
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }

    private static String read(Path path) {
        try {
            return Files.readString(path, StandardCharsets.UTF_8);
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }
}
