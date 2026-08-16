package com.ctwe.tournament.guardrails;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Guardrail G2 (see {@code docs/PUBLIC_SNAPSHOT_ARCHITECTURE.md} §5.3).
 *
 * <p>Two features must never grow into each other:
 * <ul>
 *   <li><b>Excel Export &amp; Purge</b> ({@code application.excelexport}) — DESTRUCTIVE. Exports an
 *       .xlsx and then permanently deletes the tournament's live PostgreSQL rows.</li>
 *   <li><b>Public Snapshot</b> ({@code application.publicsnapshot}) — non-destructive. Derives an
 *       immutable public JSON snapshot; never deletes anything.</li>
 * </ul>
 *
 * <p>Naming and review are not enough: an earlier design draft proposed the destructive endpoint's own
 * URL for snapshot publication. This test is the mechanical backstop, so a future change that wires
 * "publish the results" to "delete the tournament" fails the build instead of shipping.
 *
 * <p>Comments are stripped before scanning, so the deliberate cross-reference banners on both features
 * are allowed — only real code references fail.
 */
class ExcelExportSnapshotSeparationTest {
    private static final Path MAIN_SOURCES = Path.of("src/main/java");
    private static final Path EXCEL_EXPORT = MAIN_SOURCES.resolve("com/ctwe/tournament/application/excelexport");
    private static final Path PUBLIC_SNAPSHOT = MAIN_SOURCES.resolve("com/ctwe/tournament/application/publicsnapshot");

    /** Identifiers that mean "the destructive Excel export/purge feature". */
    private static final List<String> EXCEL_EXPORT_IDENTIFIERS =
        List.of("excelexport", "TournamentExcelExportService", "exportToExcelAndPurgeLiveData");

    /** Identifiers that mean "the non-destructive public snapshot feature". */
    private static final List<String> PUBLIC_SNAPSHOT_IDENTIFIERS =
        List.of("publicsnapshot", "PublicSnapshotBuilder", "PublicSnapshotPublisher", "SnapshotObjectStore");

    /**
     * The ONLY files allowed to mention the purge method. A new entry here must be a deliberate,
     * reviewed decision — adding a caller is how data loss gets introduced by accident.
     */
    private static final Set<String> PURGE_CALL_SITE_ALLOWLIST = Set.of(
        "com/ctwe/tournament/application/excelexport/TournamentExcelExportService.java",
        "com/ctwe/tournament/web/AdminController.java");

    @Test
    @DisplayName("Excel Export & Purge code never references Public Snapshot code")
    void excelExportDoesNotReferencePublicSnapshot() {
        assertNoReferences(EXCEL_EXPORT, PUBLIC_SNAPSHOT_IDENTIFIERS,
            "Excel Export & Purge must not depend on Public Snapshot");
    }

    @Test
    @DisplayName("Public Snapshot code never references Excel Export & Purge code")
    void publicSnapshotDoesNotReferenceExcelExport() {
        assertNoReferences(PUBLIC_SNAPSHOT, EXCEL_EXPORT_IDENTIFIERS,
            "Public Snapshot must never be able to trigger the destructive purge");
    }

    @Test
    @DisplayName("The purge method has no call sites outside the reviewed allowlist")
    void purgeHasOnlyAllowlistedCallSites() {
        List<String> unexpected = new ArrayList<>();
        for (Path file : javaSources(MAIN_SOURCES)) {
            String relative = MAIN_SOURCES.relativize(file).toString().replace('\\', '/');
            if (PURGE_CALL_SITE_ALLOWLIST.contains(relative)) continue;
            if (stripComments(read(file)).contains("exportToExcelAndPurgeLiveData")) unexpected.add(relative);
        }
        assertThat(unexpected)
            .as("New call site(s) for the destructive purge. If this is intended, add the file to "
                + "PURGE_CALL_SITE_ALLOWLIST in this test and explain why in the review.")
            .isEmpty();
    }

    @Test
    @DisplayName("The pre-rename names are gone, so 'archive' never again means 'delete'")
    void legacyDestructiveNamesAreNotReintroduced() {
        List<String> offenders = new ArrayList<>();
        for (Path file : javaSources(MAIN_SOURCES)) {
            String body = stripComments(read(file));
            if (body.contains("TournamentArchiveService") || body.contains("archiveAndDelete"))
                offenders.add(MAIN_SOURCES.relativize(file).toString().replace('\\', '/'));
        }
        assertThat(offenders)
            .as("'TournamentArchiveService'/'archiveAndDelete' were renamed because 'archive' now means "
                + "the non-destructive Public Snapshot. Use TournamentExcelExportService"
                + ".exportToExcelAndPurgeLiveData for the destructive path.")
            .isEmpty();
    }

    /**
     * Tables that hold tournament DATA, as opposed to snapshot bookkeeping.
     *
     * <p>Publication derives a public artifact; PostgreSQL stays the source of truth. If publication
     * could write to any of these, a published snapshot would stop being regenerable — and forcing
     * cards CLOSED on publish, which an early draft of the design called for, is exactly how that
     * would arrive.
     */
    private static final List<String> TOURNAMENT_DATA_TABLES = List.of(
        "tournament_cards", "players", "matches", "standings", "games",
        "pairing_snapshots", "final_pairings", "final_game_results", "table_seats");

    @Test
    @DisplayName("Public Snapshot code never writes to any tournament data table")
    void publicSnapshotNeverWritesTournamentData() {
        List<String> violations = new ArrayList<>();
        for (Path file : javaSources(PUBLIC_SNAPSHOT)) {
            String body = stripComments(read(file));
            for (String table : TOURNAMENT_DATA_TABLES)
                for (String verb : List.of("UPDATE " + table, "DELETE FROM " + table, "INSERT INTO " + table))
                    if (body.contains(verb))
                        violations.add(PUBLIC_SNAPSHOT.relativize(file) + " contains '" + verb + "'");
        }
        assertThat(violations)
            .as("Publication must not mutate tournament data. FINISHED/CLOSED is a PRECONDITION "
                + "checked before publishing — never something publication brings about. Snapshot "
                + "bookkeeping belongs in tournaments' snapshot_* columns and "
                + "public_snapshot_publications.")
            .isEmpty();
    }

    private void assertNoReferences(Path root, List<String> forbidden, String because) {
        if (!Files.isDirectory(root)) return; // package not created yet — the guardrail still stands
        List<String> violations = new ArrayList<>();
        for (Path file : javaSources(root)) {
            String body = stripComments(read(file));
            for (String identifier : forbidden)
                if (body.contains(identifier))
                    violations.add(root.relativize(file) + " references '" + identifier + "'");
        }
        assertThat(violations).as(because).isEmpty();
    }

    private static List<Path> javaSources(Path root) {
        if (!Files.isDirectory(root)) return List.of();
        try (Stream<Path> paths = Files.walk(root)) {
            return paths.filter(path -> path.toString().endsWith(".java")).sorted().toList();
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }

    private static String read(Path file) {
        try {
            return Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }

    /**
     * Removes block and line comments so the deliberate "this is NOT the other feature" banners do not
     * register as code references. Deliberately simple: this scans our own source, which has no
     * comment markers inside string literals.
     */
    private static String stripComments(String source) {
        return source.replaceAll("(?s)/\\*.*?\\*/", " ").replaceAll("(?m)//.*$", " ");
    }
}
