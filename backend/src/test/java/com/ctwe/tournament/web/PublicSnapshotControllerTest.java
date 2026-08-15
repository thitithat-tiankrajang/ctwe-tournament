package com.ctwe.tournament.web;

import com.ctwe.tournament.application.publicsnapshot.PublicSnapshotArtifact;
import com.ctwe.tournament.application.publicsnapshot.PublicSnapshotBuilder;
import com.ctwe.tournament.application.publicsnapshot.PublicSnapshotPayload;
import com.ctwe.tournament.application.publicsnapshot.PublicSnapshotPublisher;
import com.ctwe.tournament.application.publicsnapshot.PublicSnapshotState;
import com.ctwe.tournament.application.publicsnapshot.SnapshotApprovalService;
import com.ctwe.tournament.infrastructure.security.AuthorizationService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RequestMapping;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** The dry-run endpoint: correctly gated, and returning the snapshot's own canonical bytes. */
class PublicSnapshotControllerTest {
    private static final ObjectMapper PARSER = JsonMapper.builder().addModule(new JavaTimeModule()).build();

    private final PublicSnapshotBuilder builder = mock(PublicSnapshotBuilder.class);
    private final PublicSnapshotPublisher publisher = mock(PublicSnapshotPublisher.class);
    private final PublicSnapshotState state = mock(PublicSnapshotState.class);
    private final SnapshotApprovalService approvals = mock(SnapshotApprovalService.class);
    private final AuthorizationService authorization = mock(AuthorizationService.class);
    private final PublicSnapshotController controller =
        new PublicSnapshotController(builder, publisher, state, approvals, authorization);

    @Test
    @DisplayName("the route sits under /api/admin/** so it inherits the ADMIN-only rule")
    void isMountedUnderTheAdminNamespace() {
        String[] paths = PublicSnapshotController.class.getAnnotation(RequestMapping.class).value();

        assertThat(paths).hasSize(1);
        assertThat(paths[0])
            .as("SecurityConfiguration gates authorization by URL prefix. A path outside /api/admin/ "
                + "would silently lose the ADMIN requirement.")
            .startsWith("/api/admin/");
    }

    @Test
    @DisplayName("the response is the canonical document, with nulls intact and no-store")
    void returnsCanonicalBytes() {
        UUID tournamentId = UUID.randomUUID();
        // finalRound is null here: Spring's shared mapper uses non_null inclusion, so if the controller
        // let Spring re-serialize the object this key would vanish from the response.
        when(builder.build(any(UUID.class))).thenReturn(PublicSnapshotArtifact.of(
            new PublicSnapshotPayload(tournamentId, "รายการทดสอบ", 0, 0, List.of())));

        ResponseEntity<String> response = controller.dryRun(tournamentId);

        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getHeaders().getContentType()).isEqualTo(MediaType.APPLICATION_JSON);
        assertThat(response.getHeaders().getFirst(HttpHeaders.CACHE_CONTROL)).isEqualTo("no-store");

        JsonNode document = parse(response.getBody());
        assertThat(document.has("snapshot")).isTrue();
        assertThat(document.has("payload")).isTrue();
        assertThat(document.get("snapshot").get("schema").asInt()).isEqualTo(1);
        assertThat(document.get("snapshot").get("version").isNull())
            .as("generation assigns no version — publication does, in a later phase")
            .isTrue();
        assertThat(document.get("snapshot").get("checksum").asText()).startsWith("sha256-");
        assertThat(document.get("snapshot").get("generatedAt").asText()).isNotBlank();
        assertThat(document.get("payload").get("name").asText()).isEqualTo("รายการทดสอบ");
    }

    private static JsonNode parse(String json) {
        try {
            return PARSER.readTree(json);
        } catch (Exception error) {
            throw new IllegalStateException("Dry-run response is not valid JSON", error);
        }
    }
}
