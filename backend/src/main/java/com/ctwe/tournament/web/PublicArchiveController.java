package com.ctwe.tournament.web;

import com.ctwe.tournament.application.excelexport.TournamentExcelExportService;
import com.ctwe.tournament.web.dto.TenantDtos;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;

/**
 * Anonymous access to the .xlsx files produced by Excel Export &amp; Purge, shown on the root landing.
 * These blobs are intentionally retained as a permanent, publicly downloadable backup of finished
 * events. Read-only, and unrelated to Public Snapshot publication.
 */
@RestController
@RequestMapping("/api/public/archives")
public class PublicArchiveController {
    private final TournamentExcelExportService excelExport;

    public PublicArchiveController(TournamentExcelExportService excelExport) {
        this.excelExport = excelExport;
    }

    @GetMapping
    public List<TenantDtos.ArchiveSummary> list() {
        return excelExport.list();
    }

    @GetMapping("/{id}/download")
    public ResponseEntity<byte[]> download(@PathVariable UUID id) {
        TournamentExcelExportService.ArchiveFile file = excelExport.download(id);
        String encoded = URLEncoder.encode(file.fileName(), StandardCharsets.UTF_8).replace("+", "%20");
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"archive.xlsx\"; filename*=UTF-8''" + encoded)
            .contentType(MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
            .body(file.content());
    }
}
