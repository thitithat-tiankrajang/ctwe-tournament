package com.ctwe.tournament.application.excelexport;

import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.web.dto.CardDtos;
import com.ctwe.tournament.web.dto.TenantDtos;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.ss.usermodel.WorkbookFactory;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.Rollback;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The purge's STORAGE half, against a real PostgreSQL — the half the mocked unit tests cannot see.
 *
 * <p>Motivating incident: the .xlsx was built as an in-heap {@code XSSFWorkbook} and passed to the
 * INSERT as a {@code byte[]}. On the 512 MB container (~215 MB max heap) a large tournament ran out
 * of heap inside POI's serialiser — HTTP 500, transaction rolled back, tournament undeletable
 * forever. The workbook is now streamed to a temp file and from there into the BYTEA column, so the
 * blob never sits in the heap. That rewrite touched the INSERT, which nothing had covered: these
 * tests pin that the stored bytes are a real, readable workbook and that {@code byte_size} matches.
 */
@SpringBootTest
@Transactional
@Rollback
@EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD", matches = ".+")
class ExcelExportPurgeDatabaseTest {

    @DynamicPropertySource
    static void staffProps(DynamicPropertyRegistry registry) {
        registry.add("security.staff.username", () -> "ittest");
        registry.add("security.staff.password-hash",
            () -> "$2a$12$cpMuwSXVpR.eTscK7U7rb.Y2tw2JeakVR7bVZ5AoPESLiqZwYfZZm");
    }

    private static final String TOURNAMENT_NAME = "CTWE ทดสอบการลบ";

    @Autowired TournamentExcelExportService excelExport;
    @Autowired TournamentCardService cards;
    @Autowired JdbcTemplate jdbc;

    private UUID tournamentId;

    @BeforeEach
    void createTournament() {
        tournamentId = UUID.randomUUID();
        jdbc.update("INSERT INTO tournaments (id, name, access_token, status) VALUES (?, ?, ?, 'OPEN')",
            tournamentId, TOURNAMENT_NAME, "purge-" + tournamentId.toString().substring(0, 8));
        UUID cardId = cards.create(new CardDtos.CreateCardRequest(tournamentId, "การ์ดทดสอบ",
            "DIV", 3, List.of(PairingRuleType.SWISS, PairingRuleType.SWISS), new ArrayList<>(List.of(500, 500, 500)),
            "NONE", 0, false, PairingRuleType.RANDOM), "ittest").id();
        List<CardDtos.BulkPlayerEntry> players = new ArrayList<>();
        for (int i = 0; i < 8; i++) players.add(new CardDtos.BulkPlayerEntry("ชื่อ" + i, "สกุล" + i, "โรงเรียน" + i));
        cards.addPlayersBulk(cardId, players, "ittest");
        cards.simulate(cardId, "ittest"); // real matches, standings and results to serialise
    }

    @Test
    @DisplayName("the purge stores a readable .xlsx whose byte_size matches the blob")
    void storesAReadableWorkbook() {
        TenantDtos.ArchiveSummary summary = excelExport.exportToExcelAndPurgeLiveData(
            tournamentId, new TenantDtos.PurgeConfirmation("pw", TOURNAMENT_NAME), "ittest");

        Map<String, Object> row = jdbc.queryForMap(
            "SELECT content, byte_size, card_count, player_count FROM tournament_archives WHERE id = ?",
            summary.id());
        byte[] content = (byte[]) row.get("content");

        assertThat(content).as("an empty blob would mean the stream never reached the column").isNotEmpty();
        assertThat(row.get("byte_size"))
            .as("byte_size is reported from the file; it must describe the bytes actually stored")
            .isEqualTo((long) content.length);
        assertThat(summary.byteSize()).isEqualTo((long) content.length);
        assertThat(row.get("card_count")).isEqualTo(1);
        assertThat(row.get("player_count")).isEqualTo(8);

        // The decisive assertion: POI can reopen what we stored, so the archive is a real backup and
        // not a truncated stream that only looks like one.
        assertThat(sheetNames(content)).contains("สรุป", "C1 ผู้เล่น", "C1 ผล", "C1 อันดับ");
    }

    @Test
    @DisplayName("the live rows are gone once the archive is stored")
    void purgesTheLiveRows() {
        excelExport.exportToExcelAndPurgeLiveData(
            tournamentId, new TenantDtos.PurgeConfirmation("pw", TOURNAMENT_NAME), "ittest");

        assertThat(jdbc.queryForObject("SELECT count(*) FROM tournaments WHERE id = ?", Integer.class, tournamentId))
            .isZero();
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM tournament_cards WHERE tournament_id = ?", Integer.class, tournamentId)).isZero();
    }

    @Test
    @DisplayName("the download streams back exactly the bytes that were stored")
    void downloadStreamsTheStoredBytes() throws Exception {
        TenantDtos.ArchiveSummary summary = excelExport.exportToExcelAndPurgeLiveData(
            tournamentId, new TenantDtos.PurgeConfirmation("pw", TOURNAMENT_NAME), "ittest");
        byte[] stored = jdbc.queryForObject(
            "SELECT content FROM tournament_archives WHERE id = ?", byte[].class, summary.id());

        ByteArrayOutputStream streamed = new ByteArrayOutputStream();
        excelExport.writeContentTo(summary.id(), streamed);

        // The blob is read in 1 MiB pieces, so the assertion that matters is that the pieces are
        // reassembled in order and none is dropped, duplicated or truncated at a boundary.
        assertThat(streamed.toByteArray()).isEqualTo(stored);
        assertThat(excelExport.metadata(summary.id()).byteSize())
            .as("Content-Length is taken from here, so it must match what the stream will produce")
            .isEqualTo((long) stored.length);
    }

    @Test
    @DisplayName("an archive whose pieces span several chunks is reassembled intact")
    void downloadSpansMultipleChunks() throws Exception {
        // 2.5 MiB of incompressible bytes: three substring() round-trips, two of them full-size.
        UUID archiveId = UUID.randomUUID();
        byte[] blob = new byte[(1 << 20) * 2 + (1 << 19)];
        new java.util.Random(42).nextBytes(blob);
        jdbc.update("""
            INSERT INTO tournament_archives (id, tournament_name, file_name, content, byte_size, archived_by)
            VALUES (?, ?, ?, ?, ?, ?)
            """, archiveId, TOURNAMENT_NAME, "big.xlsx", blob, (long) blob.length, "ittest");

        ByteArrayOutputStream streamed = new ByteArrayOutputStream();
        excelExport.writeContentTo(archiveId, streamed);

        assertThat(streamed.toByteArray()).isEqualTo(blob);
    }

    @Test
    @DisplayName("downloading an unknown archive is a 404, not an empty file")
    void downloadOfUnknownArchiveIs404() {
        assertThatThrownBy(() -> excelExport.writeContentTo(UUID.randomUUID(), new ByteArrayOutputStream()))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND));
    }

    private java.util.List<String> sheetNames(byte[] content) {
        try (Workbook workbook = WorkbookFactory.create(new ByteArrayInputStream(content))) {
            java.util.List<String> names = new java.util.ArrayList<>();
            for (int i = 0; i < workbook.getNumberOfSheets(); i++) names.add(workbook.getSheetName(i));
            return names;
        } catch (Exception error) {
            throw new AssertionError("the stored archive is not a readable workbook", error);
        }
    }
}
