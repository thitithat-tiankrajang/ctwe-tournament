package com.ctwe.tournament.application;

import com.ctwe.tournament.web.dto.TenantDtos;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellStyle;
import org.apache.poi.ss.usermodel.Font;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * "Deleting" a tournament is replaced by archiving: export every card (players, results, standings) to a
 * single .xlsx, store the file, then remove the live data — all in ONE transaction so we can never delete
 * data without a safely-stored backup. The file blob stays downloadable forever (publicly).
 */
@Service
public class TournamentArchiveService {
    private static final ZoneId BANGKOK = ZoneId.of("Asia/Bangkok");
    private final JdbcTemplate jdbc;
    private final TournamentCardService cardService;

    public TournamentArchiveService(JdbcTemplate jdbc, TournamentCardService cardService) {
        this.jdbc = jdbc;
        this.cardService = cardService;
    }

    public record ArchiveFile(String fileName, byte[] content) {}

    @Transactional
    public TenantDtos.ArchiveSummary archiveAndDelete(UUID tournamentId, String actor) {
        String tournamentName;
        try {
            tournamentName = jdbc.queryForObject("SELECT name FROM tournaments WHERE id = ?", String.class, tournamentId);
        } catch (EmptyResultDataAccessException notFound) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "ไม่พบทัวร์นาเมนต์");
        }
        List<Map<String, Object>> cards = jdbc.queryForList(
            "SELECT id, name, division FROM tournament_cards WHERE tournament_id = ? ORDER BY created_at", tournamentId);
        Integer playerCount = jdbc.queryForObject(
            "SELECT count(*) FROM players WHERE card_id IN (SELECT id FROM tournament_cards WHERE tournament_id = ?)",
            Integer.class, tournamentId);

        byte[] content = buildWorkbook(tournamentName, cards);
        String safeName = tournamentName.replaceAll("[^\\p{L}\\p{N}_-]+", "_");
        String fileName = safeName + "_" + DateTimeFormatter.ofPattern("yyyyMMdd_HHmm").withZone(BANGKOK).format(Instant.now()) + ".xlsx";

        UUID archiveId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO tournament_archives (id, tournament_name, file_name, content, byte_size, card_count, player_count, archived_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, archiveId, tournamentName, fileName, content, (long) content.length, cards.size(), playerCount == null ? 0 : playerCount, actor);

        // Remove the live data only AFTER the archive blob is safely stored (same transaction).
        for (Map<String, Object> card : cards) cardService.delete((UUID) card.get("id"));
        jdbc.update("DELETE FROM tournaments WHERE id = ?", tournamentId); // cascades tournament_members only
        jdbc.update("INSERT INTO audit_logs (card_id, actor, action) VALUES (NULL, ?, 'ARCHIVE_TOURNAMENT')",
            actor == null ? "system" : actor);

        return new TenantDtos.ArchiveSummary(archiveId, tournamentName, fileName, content.length,
            cards.size(), playerCount == null ? 0 : playerCount, actor, Instant.now());
    }

    public List<TenantDtos.ArchiveSummary> list() {
        return jdbc.query("""
            SELECT id, tournament_name, file_name, byte_size, card_count, player_count, archived_by, archived_at
            FROM tournament_archives ORDER BY archived_at DESC
            """, (rs, row) -> new TenantDtos.ArchiveSummary(
                rs.getObject("id", UUID.class), rs.getString("tournament_name"), rs.getString("file_name"),
                rs.getLong("byte_size"), rs.getInt("card_count"), rs.getInt("player_count"),
                rs.getString("archived_by"), rs.getObject("archived_at", OffsetDateTime.class).toInstant()));
    }

    public ArchiveFile download(UUID id) {
        try {
            return jdbc.queryForObject("SELECT file_name, content FROM tournament_archives WHERE id = ?",
                (rs, row) -> new ArchiveFile(rs.getString("file_name"), rs.getBytes("content")), id);
        } catch (EmptyResultDataAccessException notFound) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "ไม่พบไฟล์");
        }
    }

    @Transactional
    public void deleteArchive(UUID id) {
        if (jdbc.update("DELETE FROM tournament_archives WHERE id = ?", id) == 0)
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "ไม่พบไฟล์");
    }

    // ---- Excel building (Apache POI) ----

    private byte[] buildWorkbook(String tournamentName, List<Map<String, Object>> cards) {
        try (Workbook workbook = new XSSFWorkbook(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            CellStyle header = headerStyle(workbook);

            Sheet summary = workbook.createSheet("สรุป");
            int line = 0;
            keyValue(summary, line++, header, "ทัวร์นาเมนต์", tournamentName);
            keyValue(summary, line++, header, "วันที่เก็บถาวร", DateTimeFormatter.ofPattern("d/M/yyyy HH:mm").withZone(BANGKOK).format(Instant.now()));
            keyValue(summary, line++, header, "จำนวนการ์ด", String.valueOf(cards.size()));
            line++;
            Row head = summary.createRow(line++);
            cell(head, 0, header, "การ์ด");
            cell(head, 1, header, "รุ่น/ดิวิชัน");
            for (Map<String, Object> card : cards) {
                Row row = summary.createRow(line++);
                cell(row, 0, null, card.get("name"));
                cell(row, 1, null, card.get("division"));
            }
            widths(summary, 2, 26);

            int index = 1;
            for (Map<String, Object> card : cards) {
                UUID cardId = (UUID) card.get("id");
                String cardName = String.valueOf(card.get("name"));
                playersSheet(workbook, header, "C" + index + " ผู้เล่น", cardName, cardId);
                resultsSheet(workbook, header, "C" + index + " ผล", cardName, cardId);
                standingsSheet(workbook, header, "C" + index + " อันดับ", cardName, cardId);
                Integer finalCount = jdbc.queryForObject("SELECT count(*) FROM final_pairings WHERE card_id = ?", Integer.class, cardId);
                if (finalCount != null && finalCount > 0) finalSheet(workbook, header, "C" + index + " รอบชิง", cardName, cardId);
                index++;
            }

            workbook.write(out);
            return out.toByteArray();
        } catch (IOException error) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "สร้างไฟล์ Excel ไม่สำเร็จ", error);
        }
    }

    private void playersSheet(Workbook workbook, CellStyle header, String sheetName, String cardName, UUID cardId) {
        Sheet sheet = workbook.createSheet(sheetName);
        cell(sheet.createRow(0), 0, header, "การ์ด: " + cardName);
        Row head = sheet.createRow(1);
        String[] cols = {"รหัส", "ชื่อ", "นามสกุล", "โรงเรียน/สถาบัน"};
        for (int i = 0; i < cols.length; i++) cell(head, i, header, cols[i]);
        int line = 2;
        for (Map<String, Object> player : jdbc.queryForList(
            "SELECT 'P' || lpad(code::text, 3, '0') AS external_id, first_name, last_name, school FROM players WHERE card_id = ? ORDER BY code", cardId)) {
            Row row = sheet.createRow(line++);
            cell(row, 0, null, player.get("external_id"));
            cell(row, 1, null, player.get("first_name"));
            cell(row, 2, null, player.get("last_name"));
            cell(row, 3, null, player.get("school"));
        }
        widths(sheet, cols.length, 22);
    }

    private void resultsSheet(Workbook workbook, CellStyle header, String sheetName, String cardName, UUID cardId) {
        Sheet sheet = workbook.createSheet(sheetName);
        cell(sheet.createRow(0), 0, header, "การ์ด: " + cardName);
        Row head = sheet.createRow(1);
        String[] cols = {"เกม", "โต๊ะ", "รหัส1", "ชื่อ-สกุล 1", "รหัส2", "ชื่อ-สกุล 2", "คะแนน1", "คะแนน2", "ผู้ชนะ"};
        for (int i = 0; i < cols.length; i++) cell(head, i, header, cols[i]);
        int line = 2;
        for (Map<String, Object> match : jdbc.queryForList("""
            SELECT m.game_number AS game, m.table_number AS tbl,
                   'P' || lpad(m.player_one::text, 3, '0') AS p1id, p1.first_name AS p1fn, p1.last_name AS p1ln,
                   'P' || lpad(m.player_two::text, 3, '0') AS p2id, p2.first_name AS p2fn, p2.last_name AS p2ln,
                   m.score_one AS s1, m.score_two AS s2,
                   CASE WHEN m.winner IS NULL THEN NULL ELSE 'P' || lpad(m.winner::text, 3, '0') END AS winner
            FROM matches m
            JOIN players p1 ON p1.card_id = m.card_id AND p1.code = m.player_one
            JOIN players p2 ON p2.card_id = m.card_id AND p2.code = m.player_two
            WHERE m.card_id = ? ORDER BY m.game_number, m.table_number
            """, cardId)) {
            Row row = sheet.createRow(line++);
            cell(row, 0, null, match.get("game"));
            cell(row, 1, null, match.get("tbl"));
            cell(row, 2, null, match.get("p1id"));
            cell(row, 3, null, match.get("p1fn") + " " + match.get("p1ln"));
            cell(row, 4, null, match.get("p2id"));
            cell(row, 5, null, match.get("p2fn") + " " + match.get("p2ln"));
            cell(row, 6, null, match.get("s1"));
            cell(row, 7, null, match.get("s2"));
            cell(row, 8, null, match.get("winner"));
        }
        widths(sheet, cols.length, 16);
    }

    private void standingsSheet(Workbook workbook, CellStyle header, String sheetName, String cardName, UUID cardId) {
        Sheet sheet = workbook.createSheet(sheetName);
        cell(sheet.createRow(0), 0, header, "การ์ด: " + cardName);
        Row head = sheet.createRow(1);
        String[] cols = {"อันดับ", "รหัส", "ชื่อ", "นามสกุล", "โรงเรียน/สถาบัน", "ชนะ", "แพ้", "ผลต่าง"};
        for (int i = 0; i < cols.length; i++) cell(head, i, header, cols[i]);
        int line = 2;
        for (Map<String, Object> standing : jdbc.queryForList("""
            SELECT s.rank, 'P' || lpad(p.code::text, 3, '0') AS external_id, p.first_name, p.last_name, p.school,
                   s.wins, s.losses, s.diff
            FROM standings s JOIN players p ON p.card_id = s.card_id AND p.code = s.player_code
            WHERE s.card_id = ? ORDER BY s.rank NULLS LAST, s.wins DESC, s.diff DESC
            """, cardId)) {
            Row row = sheet.createRow(line++);
            cell(row, 0, null, standing.get("rank"));
            cell(row, 1, null, standing.get("external_id"));
            cell(row, 2, null, standing.get("first_name"));
            cell(row, 3, null, standing.get("last_name"));
            cell(row, 4, null, standing.get("school"));
            cell(row, 5, null, standing.get("wins"));
            cell(row, 6, null, standing.get("losses"));
            cell(row, 7, null, standing.get("diff"));
        }
        widths(sheet, cols.length, 16);
    }

    private void finalSheet(Workbook workbook, CellStyle header, String sheetName, String cardName, UUID cardId) {
        Sheet sheet = workbook.createSheet(sheetName);
        cell(sheet.createRow(0), 0, header, "การ์ด: " + cardName + " — รอบชิงชนะเลิศ");
        Row head = sheet.createRow(1);
        String[] cols = {"คู่ชิง", "ผู้เข้าชิง 1", "ผู้เข้าชิง 2", "ผลรายเกม", "ผู้ชนะ (สรุป)", "การจัดอันดับ"};
        for (int i = 0; i < cols.length; i++) cell(head, i, header, cols[i]);
        int line = 2;
        for (Map<String, Object> pairing : jdbc.queryForList("""
            SELECT fp.slot, p1.first_name AS f1, p1.last_name AS l1, p2.first_name AS f2, p2.last_name AS l2,
                   w.first_name AS wf, w.last_name AS wl
            FROM final_pairings fp
            JOIN players p1 ON p1.card_id = fp.card_id AND p1.code = fp.player_one
            JOIN players p2 ON p2.card_id = fp.card_id AND p2.code = fp.player_two
            LEFT JOIN players w ON w.card_id = fp.card_id AND w.code = fp.winner
            WHERE fp.card_id = ? ORDER BY fp.slot
            """, cardId)) {
            int slot = ((Number) pairing.get("slot")).intValue();
            StringBuilder scores = new StringBuilder();
            for (Map<String, Object> game : jdbc.queryForList("SELECT game_index, score_one, score_two FROM final_game_results WHERE card_id = ? AND slot = ? ORDER BY game_index", cardId, slot)) {
                if (scores.length() > 0) scores.append(", ");
                Object s1 = game.get("score_one"); Object s2 = game.get("score_two");
                scores.append("เกม ").append(game.get("game_index")).append(": ").append(s1 == null ? "-" : s1).append("-").append(s2 == null ? "-" : s2);
            }
            String winner = pairing.get("wf") == null ? "ยังไม่สรุป" : (pairing.get("wf") + " " + pairing.get("wl"));
            String ranking = pairing.get("wf") == null ? "—"
                : (slot == 0 ? "ผู้ชนะ = ที่ 1, ผู้แพ้ = ที่ 2" : "ผู้ชนะ = ที่ 3, ผู้แพ้ = ที่ 4");
            Row row = sheet.createRow(line++);
            cell(row, 0, null, slot == 0 ? "ชิงอันดับ 1-2" : "ชิงอันดับ 3-4");
            cell(row, 1, null, pairing.get("f1") + " " + pairing.get("l1"));
            cell(row, 2, null, pairing.get("f2") + " " + pairing.get("l2"));
            cell(row, 3, null, scores.toString());
            cell(row, 4, null, winner);
            cell(row, 5, null, ranking);
        }
        widths(sheet, cols.length, 22);
    }

    private CellStyle headerStyle(Workbook workbook) {
        CellStyle style = workbook.createCellStyle();
        Font font = workbook.createFont();
        font.setBold(true);
        style.setFont(font);
        return style;
    }

    private void keyValue(Sheet sheet, int line, CellStyle header, String label, String value) {
        Row row = sheet.createRow(line);
        cell(row, 0, header, label);
        cell(row, 1, null, value);
    }

    private void cell(Row row, int col, CellStyle style, Object value) {
        Cell cell = row.createCell(col);
        if (value == null) cell.setBlank();
        else if (value instanceof Number number) cell.setCellValue(number.doubleValue());
        else cell.setCellValue(value.toString());
        if (style != null) cell.setCellStyle(style);
    }

    private void widths(Sheet sheet, int columns, int chars) {
        for (int i = 0; i < columns; i++) sheet.setColumnWidth(i, Math.min(255, chars) * 256);
    }
}
