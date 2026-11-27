package com.ctwe.tournament.web;

import com.ctwe.tournament.application.CardEventPublisher;
import com.ctwe.tournament.application.PairingSessionService;
import com.ctwe.tournament.application.PublicCardQueryService;
import com.ctwe.tournament.application.TournamentCardService;
import com.ctwe.tournament.application.WebPushService;
import com.ctwe.tournament.domain.model.PairingRuleType;
import com.ctwe.tournament.infrastructure.security.AuthorizationService;
import com.ctwe.tournament.infrastructure.security.AuthorizationService.Capability;
import com.ctwe.tournament.infrastructure.security.ReauthenticationService;
import com.ctwe.tournament.web.dto.CardDtos;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.session.SessionRegistry;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;

/**
 * Card operations are designed for concurrent multi-user editing (several staff/directors on the
 * same card from different machines). Mutations lock the card row and revalidate the stage.
 * Roster edits and deletions also check a version because registration can reassign player codes.
 */
@RestController
@RequestMapping("/api/cards")
public class CardController {
    private final TournamentCardService service;
    private final PublicCardQueryService publicCards;
    private final AuthorizationService authz;
    private final ReauthenticationService reauthentication;
    private final PairingSessionService pairingSession;
    private final CardEventPublisher events;
    private final WebPushService push;
    private final SessionRegistry sessions;

    public CardController(TournamentCardService service, PublicCardQueryService publicCards,
                          AuthorizationService authz, ReauthenticationService reauthentication,
                          CardEventPublisher events, WebPushService push,
                          PairingSessionService pairingSession, SessionRegistry sessions) {
        this.pairingSession = pairingSession;
        this.service = service;
        this.publicCards = publicCards;
        this.authz = authz;
        this.reauthentication = reauthentication;
        this.events = events;
        this.push = push;
        this.sessions = sessions;
    }

    @GetMapping
    public List<CardDtos.CardResponse> list(Authentication authentication) {
        if (!backOffice(authentication)) return publicCards.list();
        Set<UUID> restrict = (authz.isDirector(authentication) || authz.isStaff(authentication))
            ? authz.accessibleTournamentIds(authentication) : null;
        return service.list(true, restrict);
    }

    @GetMapping("/{cardId}")
    public CardDtos.CardResponse get(@PathVariable UUID cardId, Authentication authentication) {
        if (!backOffice(authentication)) return publicCards.get(cardId);
        // The internal view (roster, unpublished pairings, seats, Screening Pool) is tournament-scoped,
        // the same read rule as this card's staff SSE stream. Deliberately not requireCardCapability:
        // that also demands OPEN, and a CLOSED tournament must stay readable to its own operators.
        authz.requireTournamentAccess(authentication, authz.tournamentOfCard(cardId));
        return service.get(cardId, true);
    }

    /** On-demand audit log (kept out of the card payload). Role-gated to ADMIN/DIRECTOR by SecurityConfiguration. */
    @GetMapping("/{cardId}/audit")
    public List<CardDtos.AuditResponse> audit(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return service.auditLog(cardId);
    }

    /** Legacy diagnostic change detector; current clients synchronize through SSE. */
    @GetMapping("/{cardId}/version")
    public Map<String, Long> version(@PathVariable UUID cardId) {
        return Map.of("version", service.cardVersion(cardId));
    }

    @GetMapping(value = "/{cardId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@PathVariable UUID cardId, Authentication authentication, HttpServletRequest request) {
        authz.requireTournamentAccess(authentication, authz.tournamentOfCard(cardId));
        var session = request.getSession(false);
        var registeredSession = session == null ? null : sessions.getSessionInformation(session.getId());
        return events.subscribe(cardId, () -> service.cardVersion(cardId), registeredSession);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public CardDtos.CardResponse create(@Valid @RequestBody CardDtos.CreateCardRequest request, Authentication authentication) {
        authz.requireTournamentCapability(authentication, request.tournamentId(), Capability.RUN_TOURNAMENT);
        return created(service.create(request, authentication.getName()));
    }

    @PostMapping("/{cardId}/close")
    public CardDtos.CardResponse close(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(cardId, () -> service.close(cardId, authentication.getName()));
    }

    @DeleteMapping("/{cardId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        UUID tournamentId = authz.tournamentOfCard(cardId);
        long publicVersionBefore = publicCards.version(cardId);
        service.delete(cardId);
        events.publish(cardId, -1);
        // Viewers resync, hit 404, and drop the card instead of watching a frozen page.
        events.publishPublic(cardId, publicVersionBefore + 1);
        // List viewers drop the row immediately.
        events.publishTournamentCardRemoved(tournamentId, cardId);
    }

    @PostMapping("/{cardId}/players")
    @ResponseStatus(HttpStatus.CREATED)
    public CardDtos.CardResponse addPlayer(@PathVariable UUID cardId, @Valid @RequestBody CardDtos.PlayerRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.MANAGE_PLAYERS);
        return changed(cardId, () -> service.addPlayer(cardId, request, authentication.getName()));
    }

    @PostMapping("/{cardId}/players/bulk")
    @ResponseStatus(HttpStatus.CREATED)
    public CardDtos.CardResponse importPlayers(@PathVariable UUID cardId, @Valid @RequestBody CardDtos.BulkPlayersRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.MANAGE_PLAYERS);
        return changed(cardId, () -> service.addPlayersBulk(cardId, request.players(), authentication.getName()));
    }

    @PutMapping("/{cardId}/players/{playerId}")
    public CardDtos.CardResponse updatePlayer(@PathVariable UUID cardId, @PathVariable String playerId,
        @RequestHeader(value = HttpHeaders.IF_MATCH, required = false) String ifMatch,
        @Valid @RequestBody CardDtos.PlayerRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.MANAGE_PLAYERS);
        long expectedVersion = cardVersion(ifMatch);
        boolean operator = authz.isAdmin(authentication) || authz.isDirector(authentication);
        return changed(cardId, () -> service.updatePlayer(cardId, playerId, request, authentication.getName(), operator, expectedVersion));
    }

    @DeleteMapping("/{cardId}/players/{playerId}")
    public CardDtos.CardResponse removePlayer(@PathVariable UUID cardId, @PathVariable String playerId,
        @RequestHeader(value = HttpHeaders.IF_MATCH, required = false) String ifMatch, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.MANAGE_PLAYERS);
        long expectedVersion = cardVersion(ifMatch);
        return changed(cardId, () -> service.removePlayer(cardId, playerId, authentication.getName(), expectedVersion));
    }

    private static long cardVersion(String ifMatch) {
        if (ifMatch == null)
            throw new ResponseStatusException(HttpStatus.PRECONDITION_REQUIRED, "ระบุเวอร์ชันข้อมูลการแข่งขัน");
        String tag = ifMatch.strip();
        if (!tag.matches("\"[0-9]+\""))
            throw new IllegalArgumentException("Invalid If-Match header");
        return Long.parseLong(tag.substring(1, tag.length() - 1));
    }

    @PostMapping("/{cardId}/registration/finish")
    public CardDtos.CardResponse finishRegistration(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(cardId, () -> service.finishRegistration(cardId, authentication.getName()));
    }

    /**
     * Director reopens registration ("ลงทะเบียนเพิ่ม") before any game-1 result exists. The password
     * is optional: when present it is verified here, and only a verified password authorizes the
     * service to discard an already-generated game-1 pairing (the service re-checks under the row
     * lock, so a concurrently generated pairing is never dropped without re-auth).
     */
    @PostMapping("/{cardId}/registration/reopen")
    public CardDtos.CardResponse reopenRegistration(@PathVariable UUID cardId,
                                                    @RequestBody(required = false) CardDtos.ReopenRegistrationRequest request,
                                                    Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        String password = request == null ? null : request.password();
        boolean pairingDiscardConfirmed = password != null && !password.isBlank();
        if (pairingDiscardConfirmed) reauthentication.requireCurrentPassword(authentication, password);
        return changed(cardId, () -> service.reopenRegistration(cardId, pairingDiscardConfirmed, authentication.getName()));
    }

    @PostMapping("/{cardId}/tables/swap")
    public CardDtos.CardResponse swap(@PathVariable UUID cardId, @Valid @RequestBody CardDtos.SwapRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        reauthentication.requireCurrentPassword(authentication, request.password());
        return changed(cardId, () -> service.swapPlayers(cardId, request, authentication.getName()));
    }

    @PostMapping("/{cardId}/pairings/preview")
    public CardDtos.CardResponse previewPairings(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(cardId, () -> service.generatePairingPreview(cardId, authentication.getName()));
    }

    // ---- Screening Pool / Multi Switching: one tool, two entry points ----

    /** The open Screening Pool, for the tool's right-hand panel. */
    @GetMapping("/{cardId}/pairing/pool")
    public List<CardDtos.ScreeningHold> screeningPool(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.MANAGE_PAIRING);
        return pairingSession.openHolds(cardId);
    }

    /**
     * Dry run: what would this change set do?
     *
     * <p>Deliberately NOT wrapped in {@link #changed} — it writes nothing and must broadcast nothing.
     * It runs the same evaluation the commit runs, so the confirmation sheet cannot promise something
     * the commit would then refuse.
     */
    @PostMapping("/{cardId}/pairing/validate")
    public CardDtos.PairingValidationResponse validatePairingChange(
        @PathVariable UUID cardId, @Valid @RequestBody CardDtos.PairingCommitRequest request,
        Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.MANAGE_PAIRING);
        return pairingSession.validate(cardId, request);
    }

    /**
     * Apply a staged change set: pairing rows, Screening Pool rows and audit in one transaction.
     *
     * <p>The password is verified here as well as when the tool was opened. Two verifications, no
     * session token: the rule is authenticate-on-open and authenticate-on-commit, and a token would
     * add server state without guarding anything the commit's own check does not already guard.
     */
    @PostMapping("/{cardId}/pairing/commit")
    public CardDtos.CardResponse commitPairingChange(
        @PathVariable UUID cardId, @Valid @RequestBody CardDtos.PairingCommitRequest request,
        Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.MANAGE_PAIRING);
        reauthentication.requireCurrentPassword(authentication, request.password());

        // Not the generic changed() helper: staff subscribers need to know WHICH slots moved and WHO
        // moved them. The tool marks exactly those rows conflicted, and result entry locks the one
        // row it affects with a name on it — neither is possible from a bare version bump.
        long publicVersionBefore = publicCards.version(cardId);
        var outcome = pairingSession.commit(cardId, request, authentication.getName());
        events.publishPairingCommit(cardId, outcome.card(), outcome.changedSlots(), authentication.getName());
        if (publishPublicIfBumped(cardId, publicVersionBefore)) publishTournamentCatalog(cardId);
        return outcome.card();
    }

    /**
     * Announce that this director has opened or closed the pairing tool.
     *
     * <p>Advisory only — it grants nothing and blocks nothing. Fire-and-forget: a lost announcement
     * costs an indicator, never correctness, because the per-slot precondition is what actually
     * prevents two operators overwriting each other.
     */
    @PostMapping("/{cardId}/pairing/presence")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void announcePairingPresence(@PathVariable UUID cardId, @RequestParam boolean open,
                                        Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.MANAGE_PAIRING);
        events.publishPairingPresence(cardId, authentication.getName(), open);
    }

    /**
     * Verify the director's password without doing anything, so opening the tool can authenticate.
     * Returns the current pool so the panel has its contents in the same round trip.
     */
    @PostMapping("/{cardId}/pairing/session")
    public List<CardDtos.ScreeningHold> openPairingSession(
        @PathVariable UUID cardId, @Valid @RequestBody CardDtos.PasswordRequest request,
        Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.MANAGE_PAIRING);
        reauthentication.requireCurrentPassword(authentication, request.password());
        return pairingSession.openHolds(cardId);
    }

    @PostMapping("/{cardId}/pairings/undo")
    public CardDtos.CardResponse undoPairing(@PathVariable UUID cardId, @Valid @RequestBody CardDtos.PasswordRequest request,
                                             Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        reauthentication.requireCurrentPassword(authentication, request.password());
        return changed(cardId, () -> service.undoPairing(cardId, authentication.getName()));
    }

    @PostMapping("/{cardId}/pairings/unpair")
    public CardDtos.CardResponse unpairCurrentPairing(@PathVariable UUID cardId, @Valid @RequestBody CardDtos.PasswordRequest request,
                                                      Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        reauthentication.requireCurrentPassword(authentication, request.password());
        return changed(cardId, () -> service.unpairCurrentPairing(cardId, authentication.getName()));
    }

    /** Director batch-terminates players out of the running competition (password-confirmed). */
    @PostMapping("/{cardId}/players/terminate")
    public CardDtos.CardResponse terminatePlayers(@PathVariable UUID cardId, @Valid @RequestBody CardDtos.TerminateRequest request,
                                                  Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        reauthentication.requireCurrentPassword(authentication, request.password());
        return changed(cardId, () -> service.terminatePlayers(cardId, request.playerIds(), request.fromGame(), authentication.getName()));
    }

    /** Director batch-restores terminated players (password-confirmed), charging missed games as losses. */
    @PostMapping("/{cardId}/players/restore")
    public CardDtos.CardResponse restorePlayers(@PathVariable UUID cardId, @Valid @RequestBody CardDtos.RestoreRequest request,
                                                Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        reauthentication.requireCurrentPassword(authentication, request.password());
        return changed(cardId, () -> service.restorePlayers(cardId, request.playerIds(), request.lossPoints(), request.unpair(), authentication.getName()));
    }

    @PostMapping("/{cardId}/results/terminate-held")
    public CardDtos.CardResponse terminatePublicationHolds(@PathVariable UUID cardId,
            @Valid @RequestBody CardDtos.TerminateRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        if (!authz.isDirector(authentication))
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "การถอนผู้เล่นจากถังคัดชั่วคราวสงวนสำหรับผู้อำนวยการ");
        reauthentication.requireCurrentPassword(authentication, request.password());
        return changed(cardId, () -> service.terminatePublicationHolds(cardId, request.playerIds(), authentication.getName()));
    }

    @PutMapping("/{cardId}/matches/{matchId}/result")
    public CardDtos.ResultPatch submitResult(@PathVariable UUID cardId, @PathVariable String matchId,
                                             @Valid @RequestBody CardDtos.ResultRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.SUBMIT_RESULT);
        CardDtos.ResultPatch patch = service.submitResult(
            cardId, matchId, request, authentication.getName());
        events.publishResult(cardId, patch, authentication.getName(), rolesOf(authentication));
        if (patch.publicVersion() == null) return patch;
        if (patch.publicPairingsChanged()) {
            // Editing a paired source after both games' pairings are public can replace or remove
            // destination rows. Reload the authoritative shape for these structural changes.
            events.publishPublic(cardId, patch.publicVersion());
            return patch;
        }
        List<CardDtos.PairingResponse> publicChanges = patch.changedPairings().stream()
            .filter(CardDtos.PairingResponse::pairingPublished)
            .filter(pair -> pair.playerOneId() != null || pair.playerTwoId() != null)
            .toList();
        if (!publicChanges.isEmpty())
            events.publishPublicResult(cardId, patch.publicVersion(), publicChanges);
        else
            events.publishPublic(cardId, patch.publicVersion());
        return patch;
    }

    @PostMapping("/{cardId}/matches/{matchId}/force-bye")
    public CardDtos.CardResponse forceBye(@PathVariable UUID cardId, @PathVariable String matchId,
                                           @Valid @RequestBody CardDtos.ForceByeRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.FORCE_BYE);
        reauthentication.requireCurrentPassword(authentication, request.password());
        return changed(cardId, () -> service.forceBye(cardId, matchId, request.expectedPlayer(), request.score(), authentication.getName()));
    }

    @PutMapping("/{cardId}/matches/{matchId}/override")
    public CardDtos.CardResponse overrideResult(@PathVariable UUID cardId, @PathVariable String matchId,
                                                @Valid @RequestBody CardDtos.ResultRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(cardId, () -> service.overrideResult(cardId, matchId, request, authentication.getName()));
    }

    /** Director "ลงดาบ": force both players of a pairing to lose by the given points. Password-confirmed. */
    @PostMapping("/{cardId}/matches/{matchId}/penalty")
    public CardDtos.CardResponse penalty(@PathVariable UUID cardId, @PathVariable String matchId,
                                         @Valid @RequestBody CardDtos.PenaltyRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.PENALIZE_RESULT);
        reauthentication.requireCurrentPassword(authentication, request.password());
        return changed(cardId, () -> service.applyPenalty(cardId, matchId, request.points(), authentication.getName()));
    }

    /** Director-only withdrawal. The match returns to an unrecorded state and can then be entered normally. */
    @PostMapping("/{cardId}/matches/{matchId}/penalty/revoke")
    public CardDtos.CardResponse revokePenalty(@PathVariable UUID cardId, @PathVariable String matchId,
                                               @Valid @RequestBody CardDtos.PasswordRequest request,
                                               Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.PENALIZE_RESULT);
        reauthentication.requireCurrentPassword(authentication, request.password());
        return changed(cardId, () -> service.revokePenalty(cardId, matchId, authentication.getName()));
    }

    @PostMapping("/{cardId}/pairings/confirm")
    public CardDtos.CardResponse confirm(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        CardDtos.CardResponse card = changedWithPublicDelta(cardId,
            () -> service.confirmPairingPreview(cardId, authentication.getName()),
            (result, version) -> events.publishPublicPairings(
                cardId, version, result.currentGame(), publicPairingsOf(cardId, result.currentGame())));
        push.pairingPublished(cardId, card.currentGame());
        return card;
    }

    @PostMapping("/{cardId}/pairings/publish-next")
    public CardDtos.CardResponse publishNextPairing(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changedWithPublicDelta(cardId,
            () -> service.publishPairResultDestination(cardId, authentication.getName()),
            (result, version) -> {
                int destinationGame = result.currentGame() + 1;
                events.publishPublic(cardId, version);
                push.pairingPublished(cardId, destinationGame);
            });
    }

    @PostMapping("/{cardId}/results/review")
    public CardDtos.CardResponse reviewResults(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(cardId, () -> service.reviewResults(cardId, authentication.getName()));
    }

    @PostMapping("/{cardId}/results/reopen")
    public CardDtos.CardResponse reopenResults(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        return changed(cardId, () -> service.reopenResults(cardId, authentication.getName()));
    }

    @PostMapping("/{cardId}/results/publish")
    public CardDtos.CardResponse publishResults(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        CardDtos.CardResponse card = changedWithPublicDelta(cardId,
            () -> service.publishResults(cardId, authentication.getName()),
            (result, version) -> {
                // Reconcile the authoritative snapshot of grouped games. A single-game snapshot
                // can be confirmed in place by the viewer that already holds its live scores.
                CardDtos.CardResponse pub = publicCards.get(cardId);
                CardDtos.SnapshotResponse confirmed = pub.snapshots().stream()
                    .filter(item -> item.confirmedAt() != null && !item.confirmedAt().isBlank())
                    .max(java.util.Comparator.comparingInt(item ->
                        item.gameNumbers().stream().mapToInt(Integer::intValue).max().orElse(0)))
                    .orElseThrow(() -> new IllegalStateException("published card has no confirmed snapshot"));
                if (result.rules().stream().anyMatch(rule -> rule.type() == PairingRuleType.PAIR_RESULT
                        && confirmed.gameNumbers().contains(rule.toGame()))) {
                    events.publishPublic(cardId, version);
                    return;
                }
                events.publishPublicSnapshot(cardId, version, new CardEventPublisher.SnapshotPublishEvent(
                    cardId, version, java.time.Instant.now(), confirmed.id(), confirmed.gameNumbers(),
                    confirmed.confirmedAt(), pub.runtimeStage(), pub.currentGame()));
            });
        CardDtos.SnapshotResponse snapshot = card.snapshots().stream()
            .filter(item -> item.confirmedAt() != null && !item.confirmedAt().isBlank())
            .max(java.util.Comparator.comparingInt(item ->
                item.gameNumbers().stream().mapToInt(Integer::intValue).max().orElse(0)))
            .orElse(null);
        if (snapshot != null) {
            int from = snapshot.gameNumbers().stream().mapToInt(Integer::intValue).min().orElse(card.currentGame());
            int to = snapshot.gameNumbers().stream().mapToInt(Integer::intValue).max().orElse(card.currentGame());
            push.rankingPublished(cardId, from, to);
        }
        if (card.runtimeStage() == com.ctwe.tournament.domain.model.RuntimeStage.FINAL_PUBLISHED)
            push.competitionCompleted(cardId);
        return card;
    }

    // ---- final / championship round ----
    @PostMapping("/{cardId}/final/start")
    public CardDtos.CardResponse startFinal(@PathVariable UUID cardId,
        @RequestHeader(value = HttpHeaders.IF_MATCH, required = false) String ifMatch, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        Long reviewedVersion = ifMatch == null ? null : cardVersion(ifMatch);
        CardDtos.CardResponse card = changed(cardId, () -> service.startFinalRound(cardId, authentication.getName(), reviewedVersion));
        push.finalStarted(cardId);
        return card;
    }

    @PostMapping("/{cardId}/final/cancel")
    public CardDtos.CardResponse cancelFinal(@PathVariable UUID cardId,
        @RequestHeader(value = HttpHeaders.IF_MATCH, required = false) String ifMatch,
        @Valid @RequestBody CardDtos.PasswordRequest request, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        long expectedVersion = cardVersion(ifMatch);
        reauthentication.requireCurrentPassword(authentication, request.password());
        return changed(cardId, () -> service.cancelFinalRound(cardId, authentication.getName(), expectedVersion));
    }

    @PostMapping("/{cardId}/final/finish-with-regular-results")
    public CardDtos.CardResponse finishWithRegularResults(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        if (!authz.isDirector(authentication))
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "การจบด้วยอันดับรอบปกติสงวนสำหรับผู้อำนวยการ");
        CardDtos.CardResponse card = changed(cardId, () -> service.finishWithRegularResults(cardId, authentication.getName()));
        push.competitionCompleted(cardId);
        return card;
    }

    @PutMapping("/{cardId}/final/{slot}/games/{gameIndex}")
    public CardDtos.CardResponse submitFinalResult(@PathVariable UUID cardId, @PathVariable int slot, @PathVariable int gameIndex,
                                                   @Valid @RequestBody CardDtos.FinalResultRequest request, Authentication authentication) {
        requireFinalEditCapability(cardId, request.password(), authentication);
        return changed(cardId, () -> service.submitFinalResult(cardId, slot, gameIndex, request.scoreOne(), request.scoreTwo(),
            authentication.getName(), request.pairingId()));
    }

    @PutMapping("/{cardId}/final/{slot}/winner")
    public CardDtos.CardResponse setFinalWinner(@PathVariable UUID cardId, @PathVariable int slot,
                                                @Valid @RequestBody CardDtos.FinalWinnerRequest request, Authentication authentication) {
        requireFinalEditCapability(cardId, request.password(), authentication);
        return changed(cardId, () -> service.setFinalWinner(cardId, slot, request.winnerId(),
            request.winnerWins(), request.winnerLosses(), request.totalDiff(), authentication.getName(), request.pairingId()));
    }

    @PostMapping("/{cardId}/final/publish")
    public CardDtos.CardResponse publishFinal(@PathVariable UUID cardId, Authentication authentication) {
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        CardDtos.CardResponse card = changed(cardId, () -> service.publishFinalRound(cardId, authentication.getName()));
        push.competitionCompleted(cardId);
        return card;
    }

    /**
     * Runs a card mutation, notifies staff streams with the full new state, and — whenever the
     * mutation bumped the card's public version — notifies anonymous viewer streams too. Routing
     * every endpoint through this check is what keeps published data live for viewers no matter
     * which staff action produced it (rankings publish, overrides, penalties, player edits, the
     * final round, …), not just result entry and pairing publication.
     */
    private CardDtos.CardResponse changed(UUID cardId, Supplier<CardDtos.CardResponse> action) {
        long publicVersionBefore = publicCards.version(cardId);
        CardDtos.CardResponse card = action.get();
        events.publish(card);
        if (publishPublicIfBumped(cardId, publicVersionBefore)) publishTournamentCatalog(cardId);
        return card;
    }

    /**
     * Like {@link #changed}, but for the big publishes the viewer streams receive the DATA itself
     * (new pairings / snapshot confirmation) instead of a bare "something changed" bump, so no
     * viewer has to refetch the card. If building the delta fails for any reason, fall back to the
     * generic bump — viewers then resync the old way and nothing is ever silently lost.
     */
    private CardDtos.CardResponse changedWithPublicDelta(
        UUID cardId,
        Supplier<CardDtos.CardResponse> action,
        java.util.function.ObjLongConsumer<CardDtos.CardResponse> publicDelta
    ) {
        long publicVersionBefore = publicCards.version(cardId);
        CardDtos.CardResponse card = action.get();
        events.publish(card);
        long current = publicCards.version(cardId);
        if (current > publicVersionBefore) {
            try {
                publicDelta.accept(card, current);
            } catch (RuntimeException deltaFailed) {
                events.publishPublic(cardId, current);
            }
            publishTournamentCatalog(cardId);
        }
        return card;
    }

    /** The just-published public pairing rows of one game (public projection, from the read cache). */
    private List<CardDtos.PairingResponse> publicPairingsOf(UUID cardId, int gameNumber) {
        return publicCards.get(cardId).snapshots().stream()
            .filter(snapshot -> snapshot.gameNumbers().contains(gameNumber))
            .flatMap(snapshot -> snapshot.pairings().stream())
            .filter(pairing -> pairing.gameNumber() == gameNumber)
            .toList();
    }

    private void requireFinalEditCapability(UUID cardId, String password, Authentication authentication) {
        authz.requireTournamentAccess(authentication, authz.tournamentOfCard(cardId));
        CardDtos.CardResponse current = service.get(cardId, true);
        boolean published = current.runtimeStage() == com.ctwe.tournament.domain.model.RuntimeStage.FINAL_PUBLISHED
            || current.status() == com.ctwe.tournament.domain.model.CardStatus.FINISHED
            || current.status() == com.ctwe.tournament.domain.model.CardStatus.CLOSED;
        if (!published) {
            authz.requireCardCapability(authentication, cardId, Capability.SUBMIT_RESULT);
            return;
        }
        authz.requireCardCapability(authentication, cardId, Capability.RUN_TOURNAMENT);
        if (password == null || password.isBlank())
            throw new org.springframework.web.server.ResponseStatusException(HttpStatus.UNAUTHORIZED, "กรุณายืนยันรหัสผ่านผู้อำนวยการ");
        reauthentication.requireCurrentPassword(authentication, password);
    }

    /** A new card is announced on the tournament's list stream so viewers see it instantly. */
    private CardDtos.CardResponse created(CardDtos.CardResponse card) {
        events.publish(card);
        publishTournamentCatalog(card.id());
        return card;
    }

    private boolean publishPublicIfBumped(UUID cardId, long publicVersionBefore) {
        long current = publicCards.version(cardId);
        if (current <= publicVersionBefore) return false;
        events.publishPublic(cardId, current);
        return true;
    }

    /** Best-effort fan-out of the card's fresh public summary to its tournament's list viewers. */
    private void publishTournamentCatalog(UUID cardId) {
        try {
            publicCards.summaryOf(cardId).ifPresent(summary ->
                events.publishTournamentCard(summary.tournamentId(), summary));
        } catch (RuntimeException ignored) {
            // The list stream is a convenience channel; a failed lookup must never fail the mutation.
        }
    }

    /** Any authenticated back-office principal (admin/director/staff) sees the internal staff view. */
    private boolean backOffice(Authentication authentication) {
        return authz.isAdmin(authentication) || authz.isDirector(authentication) || authz.isStaff(authentication);
    }

    /**
     * The acting account's roles, derived exactly as {@code GET /api/auth/me} derives them
     * (`AuthController.me`). Same source of truth, so a concurrent-draft warning names the actor
     * the same way the session does — no second identity model (P4 SSE proof gate, fix D).
     */
    private static List<String> rolesOf(Authentication authentication) {
        if (authentication == null) return List.of();
        return authentication.getAuthorities().stream()
            .map(org.springframework.security.core.GrantedAuthority::getAuthority)
            .toList();
    }
}
