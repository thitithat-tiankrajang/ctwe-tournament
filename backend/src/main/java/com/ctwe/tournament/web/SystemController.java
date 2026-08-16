package com.ctwe.tournament.web;

import com.ctwe.tournament.application.systemlifecycle.ShutdownReadinessService;
import com.ctwe.tournament.infrastructure.security.ReauthenticationService;
import com.ctwe.tournament.web.dto.TenantDtos;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/**
 * The backend's own view of whether it may be switched off — architecture §19 (Phase G).
 *
 * <p>Read-only with respect to the lifecycle: <b>nothing here can suspend anything.</b> The effector
 * is a GitHub Actions workflow calling the Render API (§17.3), deliberately outside the application,
 * because a process cannot reliably switch itself off and must never be the sole judge of whether it
 * should be. This endpoint supplies evidence; §19.3 requires the workflow to verify every published
 * snapshot over the public internet before acting on it.
 *
 * <p>Mounted under {@code /api/admin/**}, so the existing {@code hasRole("ADMIN")} rule applies and
 * this class adds no security configuration of its own.
 */
@RestController
@RequestMapping("/api/admin/system")
public class SystemController {

    private final ShutdownReadinessService readiness;
    private final ReauthenticationService reauthentication;

    public SystemController(ShutdownReadinessService readiness, ReauthenticationService reauthentication) {
        this.readiness = readiness;
        this.reauthentication = reauthentication;
    }

    /**
     * Everything the stop workflow needs in order to decide, and to verify that decision from
     * outside (§19).
     *
     * <p>{@code no-store}: a cached readiness answer could authorize a shutdown against a tournament
     * that has since started.
     */
    @GetMapping("/shutdown-readiness")
    public ResponseEntity<ShutdownReadinessService.Readiness> shutdownReadiness() {
        return ResponseEntity.ok()
            .header(HttpHeaders.CACHE_CONTROL, "no-store")
            .body(readiness.readiness());
    }

    /**
     * Records that a tournament will never be published, so it no longer blocks a shutdown (§19.1).
     *
     * <p>Password re-authentication, matching every other tournament-level state change in the admin
     * console. Shelving publishes nothing and deletes nothing — it is reversible with
     * {@link #unshelve} — but it does let the results of a real event stay permanently non-public
     * while the backend that serves them is switched off, which deserves a deliberate act.
     */
    @PostMapping("/tournaments/{tournamentId}/shelve")
    public ShutdownReadinessService.Readiness shelve(@PathVariable UUID tournamentId,
                                                     @RequestBody TenantDtos.PasswordRequest request,
                                                     Authentication auth) {
        reauthentication.requireCurrentPassword(auth, request == null ? null : request.password());
        readiness.shelve(tournamentId, auth.getName());
        return readiness.readiness();
    }

    /** Undoes shelving; the tournament blocks a shutdown again until it is published. */
    @DeleteMapping("/tournaments/{tournamentId}/shelve")
    public ShutdownReadinessService.Readiness unshelve(@PathVariable UUID tournamentId, Authentication auth) {
        readiness.unshelve(tournamentId, auth.getName());
        return readiness.readiness();
    }
}
