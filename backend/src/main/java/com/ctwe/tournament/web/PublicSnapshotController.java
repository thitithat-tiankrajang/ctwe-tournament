package com.ctwe.tournament.web;

import com.ctwe.tournament.application.publicsnapshot.PublicSnapshotArtifact;
import com.ctwe.tournament.application.publicsnapshot.PublicSnapshotBuilder;
import com.ctwe.tournament.application.publicsnapshot.PublicSnapshotEnvelope;
import com.ctwe.tournament.application.publicsnapshot.PublicSnapshotPublisher;
import com.ctwe.tournament.application.publicsnapshot.PublicSnapshotState;
import com.ctwe.tournament.application.publicsnapshot.SnapshotApprovalService;
import com.ctwe.tournament.application.publicsnapshot.SnapshotJson;
import com.ctwe.tournament.infrastructure.security.AuthorizationService;
import com.ctwe.tournament.web.dto.PublicSnapshotDtos;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.UUID;

/**
 * Admin operations on Public Snapshots: inspect, approve, publish, roll back, retract, verify,
 * reconcile.
 *
 * <p>Not to be confused with {@code POST /api/admin/tournaments/{id}/archive}, which is Excel Export
 * &amp; Purge and permanently deletes tournament data. Nothing in this class deletes anything from
 * PostgreSQL; publication only ever writes its own bookkeeping.
 *
 * <p>Authorization comes from the existing rule for {@code /api/admin/**} ({@code hasRole("ADMIN")});
 * this class adds no security configuration of its own. Reading a <em>published</em> snapshot needs
 * no authentication at all — that happens at the CDN, not here.
 *
 * <p>Publication is gated on every card being FINISHED or CLOSED (§7.5) <em>and</em> on a live
 * approval (§4.3). Retraction is gated on neither, by design (§4.5, I9).
 *
 * <p><b>Open item O1.</b> Architecture §4.2 grants approve and publish to an ADMIN <em>or</em> a
 * DIRECTOR assigned to that tournament, and that is exactly the rule
 * {@link com.ctwe.tournament.application.publicsnapshot.SnapshotApprovalService} enforces, through
 * the shared {@link AuthorizationService}. The routes themselves still sit under
 * {@code /api/admin/**}, so the surface a director can actually reach is unchanged until O1 is
 * decided. Opening it is one {@code requestMatchers} line plus director-side UI — not a redesign,
 * because the rule is already implemented and tested a layer down.
 */
@RestController
@RequestMapping("/api/admin/tournaments/{tournamentId}/public-snapshot")
public class PublicSnapshotController {
    private final PublicSnapshotBuilder builder;
    private final PublicSnapshotPublisher publisher;
    private final PublicSnapshotState state;
    private final SnapshotApprovalService approvals;
    private final AuthorizationService authorization;

    public PublicSnapshotController(PublicSnapshotBuilder builder, PublicSnapshotPublisher publisher,
                                    PublicSnapshotState state, SnapshotApprovalService approvals,
                                    AuthorizationService authorization) {
        this.builder = builder;
        this.publisher = publisher;
        this.state = state;
        this.approvals = approvals;
        this.authorization = authorization;
    }

    @GetMapping("/status")
    public PublicSnapshotDtos.StatusResponse status(@PathVariable UUID tournamentId) {
        PublicSnapshotState.Status status = state.status(tournamentId);
        return new PublicSnapshotDtos.StatusResponse(status.state(), status.version(), status.publishedAt(),
            status.checksum(), status.objectKey(),
            publisher.publicUrlFor(status.accessToken()).orElse(null),
            status.cardCount(), status.unfinishedCardCount(), publisher.storageAvailable(),
            approvals.status(tournamentId), state.history(tournamentId));
    }

    /**
     * Approves publication — architecture §4.1, the deliberate first half of a two-step act.
     *
     * <p>Approving uploads nothing and changes nothing public. It records that a named human, having
     * re-entered their password and retyped the tournament's name against the §4.4 acknowledgment,
     * accepts that competitors' names and schools become permanently public.
     */
    @PostMapping("/approve")
    public PublicSnapshotDtos.StatusResponse approve(@PathVariable UUID tournamentId,
                                                     @RequestBody PublicSnapshotDtos.ApproveRequest request,
                                                     Authentication auth) {
        approvals.approve(tournamentId, auth, request.toApprovalRequest());
        return status(tournamentId);
    }

    /**
     * Withdraws the current approval, so publication is impossible again until someone approves
     * afresh. This does not remove anything already published — that is retraction (§4.5), which
     * Phase F owns.
     */
    @DeleteMapping("/approve")
    public PublicSnapshotDtos.StatusResponse revokeApproval(@PathVariable UUID tournamentId, Authentication auth) {
        approvals.revoke(tournamentId, auth);
        return status(tournamentId);
    }

    /**
     * Returns the snapshot that <em>would</em> be published for this tournament.
     *
     * <p>A {@code GET} because it is a pure read with no side effects. The body is written with the
     * snapshot's own canonical serializer and returned as a pre-rendered string: letting Spring's
     * shared mapper re-serialize it would apply the global {@code non_null} inclusion and hand back
     * different bytes from the ones a real snapshot would contain.
     */
    @GetMapping("/dry-run")
    public ResponseEntity<String> dryRun(@PathVariable UUID tournamentId) {
        PublicSnapshotArtifact artifact = builder.build(tournamentId);
        String document = SnapshotJson.canonical(PublicSnapshotEnvelope.of(artifact, Instant.now()));
        return ResponseEntity.ok()
            .contentType(MediaType.APPLICATION_JSON)
            .header(HttpHeaders.CACHE_CONTROL, "no-store")
            .body(document);
    }

    /**
     * Runs the publication pipeline. Idempotent in effect but not in version: each call takes a new n.
     *
     * <p>Two authorizations apply, and they are enforced in different places on purpose. <b>Who</b> —
     * §4.2's ADMIN-or-director-of-this-tournament — is checked here. <b>Whether there is a valid
     * approval</b> is checked deep inside the pipeline's claim step, under the row lock, because an
     * approval checked at the HTTP layer could be revoked before the claim it authorized.
     */
    @PostMapping("/publish")
    public PublicSnapshotPublisher.Outcome publish(@PathVariable UUID tournamentId, Authentication auth) {
        authorization.requireTournamentOperator(auth, tournamentId);
        return publisher.publish(tournamentId, auth.getName());
    }

    /** Re-promotes the previous verified version's exact bytes from private history. */
    @PostMapping("/rollback")
    public PublicSnapshotPublisher.Outcome rollback(@PathVariable UUID tournamentId, Authentication auth) {
        return publisher.rollback(tournamentId, auth.getName());
    }

    /**
     * Withdraws the published snapshot — architecture §4.5.
     *
     * <p><b>Authorization is deliberately wider than publish's.</b> Any ADMIN or any DIRECTOR of this
     * tournament may retract, with no approval record, no password re-entry and no typed
     * confirmation. That asymmetry is the design (invariant I9): publication is a considered,
     * two-step, attributable act, while stopping publication must never be the thing that is hard.
     */
    @PostMapping("/retract")
    public PublicSnapshotPublisher.Outcome retract(@PathVariable UUID tournamentId, Authentication auth) {
        authorization.requireTournamentOperator(auth, tournamentId);
        return publisher.retract(tournamentId, auth.getName());
    }

    /** Drift detection: what the public hostname serves vs. what the database recorded. Never repairs. */
    @PostMapping("/verify")
    public PublicSnapshotPublisher.Outcome verify(@PathVariable UUID tournamentId) {
        return publisher.verify(tournamentId);
    }

    /**
     * The reconciler (architecture §7.3): converges the database onto what is actually being served
     * after a publication that promoted its object but did not finish committing.
     *
     * <p>Separate from {@code verify} on purpose — {@code verify} is a pure read that any monitor may
     * call, while this one writes. It still never builds a snapshot, never deletes the public object,
     * and never touches tournament data; the only bytes it can write are already-recorded ones from
     * private history, and only after their checksum matches.
     */
    @PostMapping("/reconcile")
    public PublicSnapshotPublisher.Outcome reconcile(@PathVariable UUID tournamentId, Authentication auth) {
        return publisher.reconcile(tournamentId, auth.getName());
    }
}
