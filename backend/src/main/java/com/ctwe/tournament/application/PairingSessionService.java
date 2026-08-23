package com.ctwe.tournament.application;

import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.RuntimeStage;
import com.ctwe.tournament.infrastructure.cache.EvictPublicCard;
import com.ctwe.tournament.web.dto.CardDtos;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * The Screening Pool and Multi Switching, which are one tool with two entry points.
 *
 * <p>Screening Mode opens it filtered to the pool with bulk select; Multi Switching opens it in place
 * mode focused on problem slots. Both produce the same change set and take the same path through
 * here, so there is exactly one validator, one commit, one audit shape — and one source of truth for
 * pairings, which is why staging lives in the client and never on the server.
 *
 * <p><b>validate and commit share {@link #evaluate}.</b> The dry run is not a re-implementation of
 * the commit's checks; it is the same code with the writes withheld. That is what lets the
 * confirmation sheet promise what the commit will actually do.
 */
@Service
public class PairingSessionService {

    /** Warning codes the client echoes back in {@code confirmWarnings} to acknowledge them. */
    static final String SCHOOL_CONFLICT = "SCHOOL_CONFLICT";
    static final String REMATCH = "REMATCH";
    static final String GIBSON_DISTURBED = "GIBSON_DISTURBED";

    private final JdbcTemplate jdbc;
    private final TournamentCardService cards;
    private final ScreeningPoolStore pool;

    public PairingSessionService(JdbcTemplate jdbc, TournamentCardService cards, ScreeningPoolStore pool) {
        this.jdbc = jdbc;
        this.cards = cards;
        this.pool = pool;
    }

    // ------------------------------------------------------------------ read

    /** Dry run. Never writes, never locks, and answers exactly what a commit would do right now. */
    @Transactional(readOnly = true)
    public CardDtos.PairingValidationResponse validate(UUID cardId, CardDtos.PairingCommitRequest request) {
        return evaluate(cardId, request, readSlots(cardId, touchedKeys(cardId, request))).response();
    }

    /** The open pool, for the right-hand panel. */
    @Transactional(readOnly = true)
    public List<CardDtos.ScreeningHold> openHolds(UUID cardId) {
        String prefix = codePrefix(cardId);
        return pool.listOpen(cardId).stream().map(hold -> new CardDtos.ScreeningHold(
            code(prefix, hold.playerCode()),
            hold.screenedAt().toString(),
            hold.screenedBy(),
            hold.reason().name(),
            hold.note(),
            hold.origin().game(),
            hold.origin().table(),
            hold.origin().side(),
            code(prefix, hold.origin().opponent()),
            hold.origin().stale()
        )).toList();
    }

    // ---------------------------------------------------------------- commit

    /**
     * Apply a change set atomically: pairing rows, pool rows and audit in one transaction. SSE is
     * broadcast by the controller after this returns, as every other mutation already does.
     */
    /**
     * What a commit did: the new card, plus the slots that moved so the SSE delta can name them.
     * {@code publicChange} is true when a slot the audience has already been shown was touched.
     */
    public record CommitOutcome(CardDtos.CardResponse card, List<CardDtos.PairingChange> changedSlots,
                                boolean publicChange) {}

    @Transactional
    @EvictPublicCard
    public CommitOutcome commit(UUID cardId, CardDtos.PairingCommitRequest request, String actor) {
        // 1. Idempotency, before anything is read or written. A replayed commit — the director's
        //    network dropped and they pressed the button again — must be a no-op, not a second apply.
        int claimed = jdbc.update("""
            INSERT INTO pairing_commits (card_id, commit_key, actor, forced)
            VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING
            """, cardId, request.commitKey(), actor, request.force());
        // Already applied: return the current card with an empty change set, so a replay broadcasts
        // nothing and cannot make a subscriber think a second edit happened.
        if (claimed == 0) return new CommitOutcome(cards.get(cardId, true), List.of(), false);

        // 2. Lock the card, then the touched rows in a deterministic order so two concurrent commits
        //    on overlapping slots queue instead of deadlocking.
        List<SlotKey> keys = touchedKeys(cardId, request);
        jdbc.queryForObject("SELECT id FROM tournament_cards WHERE id = ? FOR UPDATE", UUID.class, cardId);
        Map<SlotKey, Slot> current = lockSlots(cardId, keys);

        Evaluation evaluation = evaluate(cardId, request, current);
        CardDtos.PairingValidationResponse response = evaluation.response();

        if (!response.drift().isEmpty())
            throw new SlotDriftException(response.drift());
        if (!response.blocks().isEmpty())
            throw new PairingRejectedException(response.blocks(), List.of());
        var unacknowledged = response.warnings().stream()
            .filter(warning -> !request.confirmWarnings().contains(warning.code()))
            .toList();
        if (!unacknowledged.isEmpty())
            throw new PairingRejectedException(List.of(), unacknowledged);

        // Destruction first: a slot cannot be rearranged while it still carries the result that made
        // it un-rearrangeable, and the audit row must capture the result BEFORE anything overwrites it.
        var destroyed = response.resultsToRemove();
        for (var doomed : destroyed) {
            cards.writeAudit(cardId, actor, "FORCE_REMOVE_RESULT", doomed, Map.of(
                "removedBy", actor,
                "commitKey", request.commitKey().toString(),
                "cause", "MULTI_SWITCH_FORCE"));
            cards.unwindResult(cardId, doomed.game(), doomed.table(), actor);
        }

        applyPairing(cardId, evaluation, actor);
        applyScreening(cardId, request, evaluation, actor);

        // One full replay from `matches`, not an incremental unwind — correct by construction after
        // any removal, and cheap insurance against a ranking screen that disagrees with the results.
        if (!destroyed.isEmpty()) cards.recalculateStandings(cardId);

        cards.touchCard(cardId);
        // Screening alone never reaches the public. Only a slot the audience has already been shown
        // bumps the public version — which is how "the public never sees screening" holds while
        // "committed pairing changes are public" also holds.
        // A destroyed result the audience had already seen must not simply vanish from a public
        // scoreboard: the row is marked withdrawn, and the version bump is what carries that to them.
        if (evaluation.touchesPublishedPairing() || !destroyed.isEmpty())
            cards.publishPublicVersion(cardId);
        writeAudit(cardId, request, evaluation, actor);
        return new CommitOutcome(cards.get(cardId, true), response.changes(),
            evaluation.touchesPublishedPairing() || !destroyed.isEmpty());
    }

    // -------------------------------------------------------------- evaluate

    /**
     * The single source of truth for what a change set means. Pure with respect to the database: it
     * reads the pre-image it is handed and returns a verdict plus the writes to perform.
     */
    private Evaluation evaluate(UUID cardId, CardDtos.PairingCommitRequest request, Map<SlotKey, Slot> current) {
        var card = cards.cardSummary(cardId);
        String prefix = codePrefix(cardId);

        List<CardDtos.PairingBlock> blocks = new ArrayList<>();
        List<CardDtos.PairingWarning> warnings = new ArrayList<>();
        List<CardDtos.PairingConsequence> consequences = new ArrayList<>();
        List<CardDtos.SlotDrift> drift = new ArrayList<>();
        List<CardDtos.DestroyedResult> resultsToRemove = new ArrayList<>();
        // False the moment any collided result cannot be safely unwound, so the confirmation screen
        // shows a reason instead of a button that would fail after the operator committed to it.
        boolean forceAvailable = true;

        // ---- stage: the tool only ever edits a live, generated, unsnapshotted pairing ----
        if (card.status() == CardStatus.FINISHED || card.status() == CardStatus.CLOSED)
            blocks.add(block("CARD_CLOSED", null, null, "การ์ดนี้ประกาศผลหรือปิดแล้ว แก้คู่ไม่ได้"));
        // TABLE_PAIRING is included deliberately: holding a player BEFORE the pairing is generated is
        // the preferred operational flow — the generator then simply leaves them out and there are no
        // empty slots to repair afterwards. There are no slots to rewrite in that stage, so a change
        // set that also moves players is refused per-slot by NO_SUCH_SLOT below.
        if (card.stage() != RuntimeStage.TABLE_PAIRING
            && card.stage() != RuntimeStage.PAIRING_PREVIEW
            && card.stage() != RuntimeStage.RESULT_COLLECTION)
            blocks.add(block("WRONG_STAGE", null, null,
                "พักผู้เล่น/แก้คู่ได้เฉพาะช่วงจับคู่ ตรวจ pairing และกรอกผล (ขั้นตอนปัจจุบัน: " + card.stage() + ")"));
        // Game 1 before confirmation lives in table_seats, whose player_code is NOT NULL — an empty
        // seat cannot even be represented there. Regenerating is free at that point, so it is the
        // supported route rather than teaching this tool a second storage model.
        if (card.stage() == RuntimeStage.PAIRING_PREVIEW && card.currentGame() == 1
            && cards.hasSeatLayout(cardId))
            blocks.add(block("GAME_ONE_PREVIEW", null, null,
                "เกม 1 ก่อนยืนยันคู่ ให้สุ่มจับคู่ใหม่แทนการแก้ทีละคู่"));

        List<Integer> editableGames = card.editableGames();

        // ---- resolve player codes ----
        Map<String, Integer> codes = new LinkedHashMap<>();
        for (var entry : request.screen()) resolve(cardId, entry.player(), codes, blocks);
        for (String id : request.release()) resolve(cardId, id, codes, blocks);
        for (var slot : request.slots()) {
            if (slot.one() != null) resolve(cardId, slot.one(), codes, blocks);
            if (slot.two() != null) resolve(cardId, slot.two(), codes, blocks);
        }
        if (!blocks.isEmpty()) return rejection(blocks, warnings, drift, cardId);

        Set<Integer> screening = request.screen().stream().map(e -> codes.get(e.player()))
            .collect(java.util.stream.Collectors.toCollection(LinkedHashSet::new));
        Set<Integer> releasing = request.release().stream().map(codes::get)
            .collect(java.util.stream.Collectors.toCollection(LinkedHashSet::new));
        Set<Integer> heldNow = pool.openCodes(cardId);

        // ---- drift: is the world still what the client staged against? ----
        for (var expected : request.expect()) {
            SlotKey key = new SlotKey(expected.game(), expected.table());
            Slot actual = current.get(key);
            Integer wantOne = expected.one() == null ? null : codes.computeIfAbsent(expected.one(),
                id -> cards.playerCodeOrNull(cardId, id));
            Integer wantTwo = expected.two() == null ? null : codes.computeIfAbsent(expected.two(),
                id -> cards.playerCodeOrNull(cardId, id));
            if (actual == null
                || !Objects.equals(actual.one(), wantOne) || !Objects.equals(actual.two(), wantTwo))
                drift.add(new CardDtos.SlotDrift(key.game(), key.table(),
                    expected.one(), expected.two(),
                    actual == null ? null : code(prefix, actual.one()),
                    actual == null ? null : code(prefix, actual.two())));
        }

        // ---- build the desired end state ----
        Map<SlotKey, Slot> desired = new LinkedHashMap<>();
        current.forEach((key, slot) -> desired.put(key, slot));

        // Screening vacates the player's seat wherever it is; the server locates it rather than
        // trusting the client to, so the two can never disagree about where someone was sitting.
        Map<Integer, ScreenOrigin> origins = new LinkedHashMap<>();
        for (int code : screening) {
            if (heldNow.contains(code)) continue;                 // convergent: already held
            SlotKey key = null;
            for (var entry : desired.entrySet())
                if (Objects.equals(entry.getValue().one(), code) || Objects.equals(entry.getValue().two(), code))
                    key = entry.getKey();
            if (key == null) { origins.put(code, ScreenOrigin.UNSEATED); continue; }
            Slot slot = desired.get(key);
            boolean isOne = Objects.equals(slot.one(), code);
            origins.put(code, new ScreenOrigin(key.game(), key.table(), isOne ? 1 : 2,
                isOne ? slot.two() : slot.one()));
            desired.put(key, isOne ? slot.withOne(null) : slot.withTwo(null));
        }

        // Explicit occupancy rewrites are applied after screening so a slot can be vacated and
        // refilled in one change set.
        for (var wanted : request.slots()) {
            SlotKey key = new SlotKey(wanted.game(), wanted.table());
            if (!current.containsKey(key)) {
                blocks.add(block("NO_SUCH_SLOT", key.game(), key.table(),
                    "ไม่พบคู่ที่ " + key.table() + " ของเกม " + key.game()));
                continue;
            }
            desired.put(key, new Slot(
                wanted.one() == null ? null : codes.get(wanted.one()),
                wanted.two() == null ? null : codes.get(wanted.two()),
                current.get(key).resultType(), current.get(key).snapshotNo(),
                current.get(key).voided(), current.get(key).publishedAt(),
                current.get(key).oneGibsonized(), current.get(key).twoGibsonized()));
        }

        // ---- hard blocks ----
        for (var entry : current.entrySet()) {
            SlotKey key = entry.getKey();
            Slot before = entry.getValue();
            Slot after = desired.get(key);
            if (before.sameOccupancy(after)) continue;

            if (before.snapshotNo() != null)
                blocks.add(block("SNAPSHOTTED", key.game(), key.table(),
                    "คู่ที่ " + key.table() + " เกม " + key.game() + " ยืนยันแล้ว แก้ไม่ได้"));
            if (!editableGames.contains(key.game()))
                blocks.add(block("GAME_NOT_EDITABLE", key.game(), key.table(),
                    "แก้ได้เฉพาะเกมใน block ปัจจุบัน " + editableGames));
            // A recorded result stops an ordinary commit outright. Force can clear it — but only
            // when it is genuinely unwindable, which is the pre-check below, not a promise.
            if (before.resultType() != null) {
                String reason = cards.unwindBlocker(cardId, key.game(), key.table());
                if (!request.force())
                    blocks.add(block("HAS_RESULT", key.game(), key.table(),
                        "คู่ที่ " + key.table() + " เกม " + key.game()
                            + " กรอกผลแล้ว — ต้องใช้การบังคับบันทึกเพื่อลบผลนั้น"));
                else if (reason != null)
                    blocks.add(block("UNWINDABLE", key.game(), key.table(),
                        "คู่ที่ " + key.table() + " เกม " + key.game() + ": " + reason));
                var detail = cards.resultDetail(cardId, key.game(), key.table());
                if (detail != null) {
                    resultsToRemove.add(detail);
                    if (reason != null) forceAvailable = false;
                }
            }
        }

        // A player may sit in at most one seat.
        Map<Integer, SlotKey> seatOf = new LinkedHashMap<>();
        for (var entry : desired.entrySet())
            // Iterate the array, not List.of(...) — an empty seat is null and List.of rejects nulls.
            for (Integer occupant : entry.getValue().occupants())
                if (occupant != null) {
                    SlotKey clash = seatOf.put(occupant, entry.getKey());
                    if (clash != null)
                        blocks.add(block("DUPLICATE_PLAYER", entry.getKey().game(), entry.getKey().table(),
                            code(prefix, occupant) + " ถูกจัดไว้สองที่ (คู่ที่ " + clash.table()
                                + " และ " + entry.getKey().table() + ")"));
                }

        for (var entry : seatOf.entrySet()) {
            int code = entry.getKey();
            if (cards.isTerminated(cardId, code))
                blocks.add(block("TERMINATED_PLAYER", entry.getValue().game(), entry.getValue().table(),
                    code(prefix, code) + " ถูก terminate แล้ว จัดลงคู่ไม่ได้"));
            // Seating someone who is held only makes sense as part of releasing them.
            if (heldNow.contains(code) && !releasing.contains(code))
                blocks.add(block("STILL_SCREENED", entry.getValue().game(), entry.getValue().table(),
                    code(prefix, code) + " อยู่ใน Screening Pool ต้องนำออกจาก pool พร้อมกัน"));
            if (screening.contains(code))
                blocks.add(block("SCREENED_AND_SEATED", entry.getValue().game(), entry.getValue().table(),
                    code(prefix, code) + " ถูกเลือกให้เข้า Screening Pool และถูกจัดลงคู่พร้อมกัน"));
        }

        // Rule 3: there is no "active but unpaired". Leaving the pool means landing in a seat.
        for (int code : releasing) {
            if (!heldNow.contains(code))
                blocks.add(block("NOT_SCREENED", null, null,
                    code(prefix, code) + " ไม่ได้อยู่ใน Screening Pool"));
            else if (!seatOf.containsKey(code))
                blocks.add(block("RELEASED_WITHOUT_SEAT", null, null,
                    code(prefix, code) + " ต้องมีคู่รองรับก่อนจึงจะออกจาก Screening Pool ได้"));
        }

        // ---- warnings ----
        for (var entry : desired.entrySet()) {
            SlotKey key = entry.getKey();
            Slot before = current.get(key);
            Slot after = entry.getValue();
            if (before.sameOccupancy(after)) continue;

            Integer one = after.one();
            Integer two = after.two();
            if (one != null && two != null) {
                if (cards.shareSchool(cardId, one, two))
                    warnings.add(new CardDtos.PairingWarning(SCHOOL_CONFLICT, key.game(), key.table(),
                        code(prefix, one) + " และ " + code(prefix, two) + " มาจากโรงเรียนเดียวกัน"));
                if (cards.haveMetBefore(cardId, one, two))
                    warnings.add(new CardDtos.PairingWarning(REMATCH, key.game(), key.table(),
                        code(prefix, one) + " และ " + code(prefix, two) + " เคยพบกันมาแล้ว"));
            }
            if (before.oneGibsonized() || before.twoGibsonized())
                warnings.add(new CardDtos.PairingWarning(GIBSON_DISTURBED, key.game(), key.table(),
                    "คู่ที่ " + key.table() + " เกม " + key.game() + " เป็นคู่ Gibson การแก้ไขจะเปลี่ยนผลของกติกานี้"));
        }

        // ---- consequences ----
        for (var entry : desired.entrySet()) {
            SlotKey key = entry.getKey();
            Slot before = current.get(key);
            Slot after = entry.getValue();
            if (before.sameOccupancy(after)) continue;
            boolean wasBye = before.isBye();
            boolean isBye = after.isBye();
            boolean isEmpty = after.one() == null && after.two() == null;
            if (isEmpty && !before.voided())
                consequences.add(new CardDtos.PairingConsequence("BECOMES_VOID", key.game(), key.table(), null));
            else if (isBye && !wasBye)
                consequences.add(new CardDtos.PairingConsequence("BECOMES_BYE", key.game(), key.table(),
                    code(prefix, after.one() != null ? after.one() : after.two())));
            else if (!isBye && wasBye && before.voided())
                consequences.add(new CardDtos.PairingConsequence("UNVOIDED", key.game(), key.table(), null));
        }
        for (int code : screening)
            if (!heldNow.contains(code))
                consequences.add(new CardDtos.PairingConsequence("POOL_ADD", null, null, code(prefix, code)));
        for (int code : releasing)
            consequences.add(new CardDtos.PairingConsequence("POOL_REMOVE", null, null, code(prefix, code)));

        // ---- changes ----
        List<CardDtos.PairingChange> changes = new ArrayList<>();
        desired.forEach((key, after) -> {
            Slot before = current.get(key);
            if (!before.sameOccupancy(after))
                changes.add(new CardDtos.PairingChange(key.game(), key.table(),
                    code(prefix, before.one()), code(prefix, before.two()),
                    code(prefix, after.one()), code(prefix, after.two())));
        });
        changes.sort(Comparator.comparingInt(CardDtos.PairingChange::game)
            .thenComparingInt(CardDtos.PairingChange::table));

        boolean touchesPublished = desired.entrySet().stream().anyMatch(entry ->
            !current.get(entry.getKey()).sameOccupancy(entry.getValue())
                && current.get(entry.getKey()).publishedAt() != null);

        for (var doomed : resultsToRemove)
            consequences.add(new CardDtos.PairingConsequence(
                "RESULT_REMOVED", doomed.game(), doomed.table(), doomed.winner()));

        var response = new CardDtos.PairingValidationResponse(
            blocks.isEmpty() && drift.isEmpty(),
            changes, consequences, warnings, blocks, drift, openHolds(cardId),
            List.copyOf(resultsToRemove), forceAvailable);
        return new Evaluation(response, current, desired, origins, touchesPublished);
    }

    // ----------------------------------------------------------------- write

    private void applyPairing(UUID cardId, Evaluation evaluation, String actor) {
        evaluation.desired().forEach((key, after) -> {
            Slot before = evaluation.current().get(key);
            if (before.sameOccupancy(after)) return;
            jdbc.update("""
                UPDATE matches SET player_one = ?, player_two = ?
                WHERE card_id = ? AND game_number = ? AND table_number = ?
                """, after.one(), after.two(), cardId, key.game(), key.table());
            boolean empty = after.one() == null && after.two() == null;
            if (empty && !before.voided())
                // Vacated entirely: void it rather than delete it. Seat numbers are derived from
                // table_number, so removing a row silently renumbers every seat after it — including
                // on table cards already handed out.
                jdbc.update("""
                    UPDATE matches SET voided_at = now(), voided_by = ?
                    WHERE card_id = ? AND game_number = ? AND table_number = ?
                    """, actor, cardId, key.game(), key.table());
            else if (!empty && before.voided())
                jdbc.update("""
                    UPDATE matches SET voided_at = NULL, voided_by = NULL
                    WHERE card_id = ? AND game_number = ? AND table_number = ?
                    """, cardId, key.game(), key.table());
        });
    }

    private void applyScreening(UUID cardId, CardDtos.PairingCommitRequest request,
                                Evaluation evaluation, String actor) {
        // Stale-marking runs FIRST, against the holds that existed before this commit. Doing it last
        // would mark the holds this very commit just created — their origin slot is by definition one
        // of the slots it touched — so a card opened one second ago would claim its own context was
        // already out of date, which is both false and exactly the kind of thing that teaches an
        // operator to ignore the marker.
        List<int[]> touched = new ArrayList<>();
        evaluation.desired().forEach((key, after) -> {
            if (!evaluation.current().get(key).sameOccupancy(after))
                touched.add(new int[] { key.game(), key.table() });
        });
        if (!touched.isEmpty()) pool.markOriginStale(cardId, touched);

        for (var entry : request.screen()) {
            Integer code = cards.playerCodeOrNull(cardId, entry.player());
            if (code == null) continue;
            ScreenOrigin origin = evaluation.origins().getOrDefault(code, ScreenOrigin.UNSEATED);
            pool.open(cardId, code, ScreeningPoolStore.reasonOf(entry.reason()), entry.note(),
                new ScreeningPoolStore.Origin(origin.game(), origin.table(), origin.side(),
                    origin.opponent(), false),
                actor);
        }
        for (String id : request.release()) {
            Integer code = cards.playerCodeOrNull(cardId, id);
            if (code != null) pool.close(cardId, code, ScreeningPoolStore.Resolution.RETURNED, actor);
        }
    }

    private void writeAudit(UUID cardId, CardDtos.PairingCommitRequest request,
                            Evaluation evaluation, String actor) {
        var response = evaluation.response();
        Map<String, Object> before = new LinkedHashMap<>();
        Map<String, Object> after = new LinkedHashMap<>();
        before.put("slots", response.changes().stream().map(change -> Map.of(
            "game", change.game(), "table", change.table(),
            "one", String.valueOf(change.beforeOne()), "two", String.valueOf(change.beforeTwo()))).toList());
        before.put("pool", evaluation.poolBefore());
        after.put("slots", response.changes().stream().map(change -> Map.of(
            "game", change.game(), "table", change.table(),
            "one", String.valueOf(change.afterOne()), "two", String.valueOf(change.afterTwo()))).toList());
        after.put("screened", request.screen().stream()
            .map(entry -> Map.of("player", entry.player(), "reason", entry.reason())).toList());
        after.put("released", request.release());
        after.put("consequences", response.consequences().stream()
            .map(consequence -> consequence.kind() + (consequence.table() == null ? ""
                : ":" + consequence.game() + ":" + consequence.table())).toList());
        after.put("acknowledged", request.confirmWarnings());
        after.put("commitKey", request.commitKey().toString());
        after.put("forced", request.force());
        after.put("resultsRemoved", evaluation.response().resultsToRemove().stream()
            .map(doomed -> "g" + doomed.game() + "t" + doomed.table()).toList());
        cards.writeAudit(cardId, actor, "PAIRING_COMMIT", before, after);
    }

    // ------------------------------------------------------------------ read helpers

    /** Every slot the change set reads or writes: the client's preconditions, its targets, and the
     *  seats currently occupied by anyone being screened (which the server locates itself). */
    private List<SlotKey> touchedKeys(UUID cardId, CardDtos.PairingCommitRequest request) {
        Set<SlotKey> keys = new LinkedHashSet<>();
        for (var slot : request.expect()) keys.add(new SlotKey(slot.game(), slot.table()));
        for (var slot : request.slots()) keys.add(new SlotKey(slot.game(), slot.table()));
        // The seat a screened player currently occupies — located server-side so the client cannot
        // disagree with the server about where someone was sitting.
        for (var entry : request.screen()) addCurrentSeat(cardId, entry.player(), keys);

        // The seat every player being PLACED currently occupies. Without this, moving someone into a
        // new slot while leaving their old one alone would seat them twice: the old slot is never
        // loaded, so the duplicate check cannot see it. Loading both ends makes the end state complete
        // — and therefore checkable — and locks the row the move actually vacates.
        for (var slot : request.slots()) {
            if (slot.one() != null) addCurrentSeat(cardId, slot.one(), keys);
            if (slot.two() != null) addCurrentSeat(cardId, slot.two(), keys);
        }
        return keys.stream()
            .sorted(Comparator.comparingInt(SlotKey::game).thenComparingInt(SlotKey::table))
            .toList();
    }

    /** Add whichever unsnapshotted slot this player currently sits in, if any. */
    private void addCurrentSeat(UUID cardId, String externalId, Set<SlotKey> keys) {
        Integer code = cards.playerCodeOrNull(cardId, externalId);
        if (code == null) return;
        jdbc.query("""
            SELECT game_number, table_number FROM matches
            WHERE card_id = ? AND snapshot_no IS NULL AND (player_one = ? OR player_two = ?)
            """, rs -> { keys.add(new SlotKey(rs.getInt(1), rs.getInt(2))); }, cardId, code, code);
    }

    private Map<SlotKey, Slot> readSlots(UUID cardId, List<SlotKey> keys) {
        return loadSlots(cardId, keys, false);
    }

    private Map<SlotKey, Slot> lockSlots(UUID cardId, List<SlotKey> keys) {
        return loadSlots(cardId, keys, true);
    }

    private Map<SlotKey, Slot> loadSlots(UUID cardId, List<SlotKey> keys, boolean forUpdate) {
        Map<SlotKey, Slot> slots = new LinkedHashMap<>();
        // Row by row, in the caller's sorted order: FOR UPDATE with an IN-list gives no ordering
        // guarantee, and two commits locking the same slots in different orders would deadlock.
        for (SlotKey key : keys) {
            var found = jdbc.query("""
                SELECT player_one, player_two, result_type, snapshot_no, voided_at,
                       pairing_published_at, player_one_gibsonized, player_two_gibsonized
                FROM matches WHERE card_id = ? AND game_number = ? AND table_number = ?
                """ + (forUpdate ? " FOR UPDATE" : ""),
                (rs, row) -> new Slot(
                    (Integer) rs.getObject("player_one"), (Integer) rs.getObject("player_two"),
                    rs.getString("result_type"), (Integer) rs.getObject("snapshot_no"),
                    rs.getTimestamp("voided_at") != null,
                    rs.getTimestamp("pairing_published_at"),
                    rs.getBoolean("player_one_gibsonized"), rs.getBoolean("player_two_gibsonized")),
                cardId, key.game(), key.table());
            if (!found.isEmpty()) slots.put(key, found.get(0));
        }
        return slots;
    }

    private void resolve(UUID cardId, String externalId, Map<String, Integer> into,
                         List<CardDtos.PairingBlock> blocks) {
        if (into.containsKey(externalId)) return;
        Integer code = cards.playerCodeOrNull(cardId, externalId);
        if (code == null) blocks.add(block("UNKNOWN_PLAYER", null, null, "ไม่พบนักกีฬา " + externalId));
        else into.put(externalId, code);
    }

    private Evaluation rejection(List<CardDtos.PairingBlock> blocks, List<CardDtos.PairingWarning> warnings,
                                 List<CardDtos.SlotDrift> drift, UUID cardId) {
        var response = new CardDtos.PairingValidationResponse(false, List.of(), List.of(),
            warnings, blocks, drift, openHolds(cardId), List.of(), false);
        return new Evaluation(response, Map.of(), Map.of(), Map.of(), false);
    }

    private static CardDtos.PairingBlock block(String code, Integer game, Integer table, String message) {
        return new CardDtos.PairingBlock(code, game, table, message);
    }

    private String codePrefix(UUID cardId) {
        return jdbc.queryForObject("SELECT code_prefix FROM tournament_cards WHERE id = ?", String.class, cardId);
    }

    private static String code(String prefix, Integer value) {
        return value == null ? null : prefix + String.format("%03d", value);
    }

    // ------------------------------------------------------------------ types

    record SlotKey(int game, int table) {}

    record Slot(Integer one, Integer two, String resultType, Integer snapshotNo, boolean voided,
                java.sql.Timestamp publishedAt, boolean oneGibsonized, boolean twoGibsonized) {
        Slot withOne(Integer value) {
            return new Slot(value, two, resultType, snapshotNo, voided, publishedAt, oneGibsonized, twoGibsonized);
        }
        Slot withTwo(Integer value) {
            return new Slot(one, value, resultType, snapshotNo, voided, publishedAt, oneGibsonized, twoGibsonized);
        }
        Integer[] occupants() { return new Integer[] { one, two }; }
        boolean isBye() { return (one == null) != (two == null); }
        boolean sameOccupancy(Slot other) {
            return other != null && Objects.equals(one, other.one()) && Objects.equals(two, other.two());
        }
    }

    record ScreenOrigin(Integer game, Integer table, Integer side, Integer opponent) {
        static final ScreenOrigin UNSEATED = new ScreenOrigin(null, null, null, null);
    }

    record Evaluation(CardDtos.PairingValidationResponse response, Map<SlotKey, Slot> current,
                      Map<SlotKey, Slot> desired, Map<Integer, ScreenOrigin> origins,
                      boolean touchesPublishedPairing) {
        List<String> poolBefore() {
            return response.pool().stream().map(CardDtos.ScreeningHold::player).toList();
        }
    }

    /** 409: the world moved under the staged change set. Carries the slots that drifted. */
    public static class SlotDriftException extends RuntimeException {
        private final transient List<CardDtos.SlotDrift> drift;
        SlotDriftException(List<CardDtos.SlotDrift> drift) { super("slot drift"); this.drift = drift; }
        public List<CardDtos.SlotDrift> drift() { return drift; }
    }

    /** 422: a hard block, or a warning the operator has not acknowledged. */
    public static class PairingRejectedException extends RuntimeException {
        private final transient List<CardDtos.PairingBlock> blocks;
        private final transient List<CardDtos.PairingWarning> warnings;
        PairingRejectedException(List<CardDtos.PairingBlock> blocks, List<CardDtos.PairingWarning> warnings) {
            super("pairing rejected");
            this.blocks = blocks;
            this.warnings = warnings;
        }
        public List<CardDtos.PairingBlock> blocks() { return blocks; }
        public List<CardDtos.PairingWarning> warnings() { return warnings; }
    }
}
