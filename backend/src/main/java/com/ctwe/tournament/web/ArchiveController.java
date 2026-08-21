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
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;

/**
 * Admin-only access to the .xlsx files produced by Excel Export &amp; Purge. Read-only: listing and
 * downloading these blobs never touches live data. Not related to Public Snapshot publication.
 */
@RestController
@RequestMapping("/api/archives")
public class ArchiveController {
    private final TournamentExcelExportService excelExport;

    public ArchiveController(TournamentExcelExportService excelExport) { this.excelExport = excelExport; }

    @GetMapping
    public List<TenantDtos.ArchiveSummary> list() {
        return excelExport.list();
    }

    /**
     * Streams the blob straight to the client. The file is never held in the heap as one array — see
     * {@link TournamentExcelExportService#writeContentTo}; the metadata lookup here is what makes the
     * headers (including Content-Length) available without reading the bytes first.
     */
    @GetMapping("/{id}/download")
    public ResponseEntity<StreamingResponseBody> download(@PathVariable UUID id) {
        TournamentExcelExportService.ArchiveMetadata file = excelExport.metadata(id);
        String encoded = URLEncoder.encode(file.fileName(), StandardCharsets.UTF_8).replace("+", "%20");
        StreamingResponseBody body = out -> excelExport.writeContentTo(id, out);
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"archive.xlsx\"; filename*=UTF-8''" + encoded)
            .contentType(MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
            .contentLength(file.byteSize())
            .body(body);
    }
}
