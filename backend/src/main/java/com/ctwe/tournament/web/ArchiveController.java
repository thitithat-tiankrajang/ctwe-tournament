package com.ctwe.tournament.web;

import com.ctwe.tournament.application.TournamentArchiveService;
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

/** Public read access to archived (exported-to-Excel) tournaments — anyone can list and download. */
@RestController
@RequestMapping("/api/archives")
public class ArchiveController {
    private final TournamentArchiveService archive;

    public ArchiveController(TournamentArchiveService archive) { this.archive = archive; }

    @GetMapping
    public List<TenantDtos.ArchiveSummary> list() {
        return archive.list();
    }

    @GetMapping("/{id}/download")
    public ResponseEntity<byte[]> download(@PathVariable UUID id) {
        TournamentArchiveService.ArchiveFile file = archive.download(id);
        String encoded = URLEncoder.encode(file.fileName(), StandardCharsets.UTF_8).replace("+", "%20");
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"archive.xlsx\"; filename*=UTF-8''" + encoded)
            .contentType(MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
            .body(file.content());
    }
}
