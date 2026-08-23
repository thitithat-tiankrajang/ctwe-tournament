package com.ctwe.tournament.domain.ranking;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The ranking rule, executed from {@code docs/ranking-vectors.json} — the SAME file the Node suite
 * reads. Two languages compute this rule independently; these shared vectors are what stop them
 * drifting apart without anyone noticing.
 *
 * <p>The vectors pin the laziness requirement too: {@code aggregations} is the number of full
 * head-to-head aggregations the engine is allowed to perform, so a change that quietly builds a
 * tournament-wide matrix fails here rather than in production.
 */
class RankingEngineVectorTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static JsonNode vectors() throws IOException {
        // Tests run with the module directory as the working directory; the vectors live at the
        // repository root so both languages read one file.
        for (Path candidate : List.of(Path.of("..", "docs", "ranking-vectors.json"), Path.of("docs", "ranking-vectors.json")))
            if (Files.exists(candidate)) return MAPPER.readTree(Files.readString(candidate)).get("vectors");
        throw new IllegalStateException("docs/ranking-vectors.json not found relative to " + Path.of("").toAbsolutePath());
    }

    @TestFactory
    Stream<DynamicTest> everyVectorMatchesTheTypeScriptRule() throws IOException {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode vector : vectors()) {
            String name = vector.get("name").asText();
            tests.add(DynamicTest.dynamicTest(name, () -> runVector(vector)));
        }
        assertThat(tests).as("vector file is not empty").isNotEmpty();
        return tests.stream();
    }

    private void runVector(JsonNode vector) {
        List<RankingEngine.RankRow> rows = new ArrayList<>();
        for (JsonNode player : vector.get("players"))
            rows.add(new RankingEngine.RankRow(player.get("id").asText(), player.get("winPoints").asInt(),
                player.get("diff").asInt(), player.get("scoreFor").asLong(), player.get("games").asInt()));

        CountingProvider provider = new CountingProvider(vector.get("meetings"));
        List<RankingEngine.Ranked> ranked = RankingEngine.rank(rows, provider);

        List<String> expectedOrder = new ArrayList<>();
        for (JsonNode id : vector.get("expectedOrder")) expectedOrder.add(id.asText());
        assertThat(ranked.stream().map(RankingEngine.Ranked::playerId)).as("order").containsExactlyElementsOf(expectedOrder);

        for (int index = 0; index < ranked.size(); index++)
            assertThat(ranked.get(index).order()).as("order index").isEqualTo(index);

        if (vector.has("expectedDisplayRanks")) {
            Map<String, Integer> actual = new LinkedHashMap<>();
            ranked.forEach(entry -> actual.put(entry.playerId(), entry.displayRank()));
            Map<String, Integer> expected = new LinkedHashMap<>();
            vector.get("expectedDisplayRanks").fields()
                .forEachRemaining(field -> expected.put(field.getKey(), field.getValue().asInt()));
            assertThat(actual).as("displayRank").containsAllEntriesOf(expected);
        }

        if (vector.has("aggregations"))
            assertThat(provider.aggregations).as("full H2H aggregations performed")
                .isEqualTo(vector.get("aggregations").asInt());
    }

    @Test
    void rankingIsDeterministicWhateverOrderRowsArriveIn() throws IOException {
        JsonNode vector = null;
        for (JsonNode candidate : vectors())
            if (candidate.get("name").asText().startsWith("H2H example 2b")) vector = candidate;
        assertThat(vector).isNotNull();

        List<RankingEngine.RankRow> rows = new ArrayList<>();
        for (JsonNode player : vector.get("players"))
            rows.add(new RankingEngine.RankRow(player.get("id").asText(), player.get("winPoints").asInt(),
                player.get("diff").asInt(), player.get("scoreFor").asLong(), player.get("games").asInt()));

        List<String> expected = RankingEngine.rank(rows, new CountingProvider(vector.get("meetings")))
            .stream().map(RankingEngine.Ranked::playerId).toList();
        for (int attempt = 0; attempt < 200; attempt++) {
            List<RankingEngine.RankRow> shuffled = new ArrayList<>(rows);
            java.util.Collections.shuffle(shuffled);
            assertThat(RankingEngine.rank(shuffled, new CountingProvider(vector.get("meetings")))
                .stream().map(RankingEngine.Ranked::playerId).toList()).isEqualTo(expected);
        }
    }

    @Test
    void averageScoreGuardsTheDivision() {
        assertThat(RankingEngine.averageScore(103, 2)).isEqualTo(51.5);
        assertThat(RankingEngine.averageScore(0, 0)).isEqualTo(0d);
        assertThat(RankingEngine.averageScore(500, 0)).isEqualTo(0d);
    }

    @Test
    void withoutAProviderNoHeadToHeadIsApplied() {
        List<RankingEngine.RankRow> rows = List.of(
            new RankingEngine.RankRow("1", 4, 0, 5000, 1),
            new RankingEngine.RankRow("2", 4, 0, 4000, 1));
        assertThat(RankingEngine.rank(rows).stream().map(RankingEngine.Ranked::playerId)).containsExactly("1", "2");
    }

    /** Mirrors the Node suite's provider: memoised, and counts full aggregations. */
    private static final class CountingProvider implements H2HProvider {
        private final List<JsonNode> meetings = new ArrayList<>();
        private final Map<String, Set<String>> met = new HashMap<>();
        private final Map<String, Verdict> cache = new HashMap<>();
        private int aggregations;

        private CountingProvider(JsonNode nodes) {
            for (JsonNode meeting : nodes) {
                // A penalty is not a game, so it never reaches the head-to-head record at all.
                if (meeting.path("penalty").asBoolean(false)) continue;
                meetings.add(meeting);
                met.computeIfAbsent(meeting.get("a").asText(), ignored -> new HashSet<>()).add(meeting.get("b").asText());
                met.computeIfAbsent(meeting.get("b").asText(), ignored -> new HashSet<>()).add(meeting.get("a").asText());
            }
        }

        public boolean hasMet(String playerId, String opponentId) {
            return met.getOrDefault(playerId, Set.of()).contains(opponentId);
        }

        public Verdict verdict(String playerId, String opponentId) {
            String key = playerId.compareTo(opponentId) <= 0
                ? playerId + "|" + opponentId : opponentId + "|" + playerId;
            boolean forward = key.startsWith(playerId + "|");
            Verdict cached = cache.get(key);
            if (cached != null) return forward ? cached : flip(cached);

            aggregations++;
            int wins = 0;
            long diff = 0;
            long points = 0;
            long against = 0;
            for (JsonNode meeting : meetings) {
                boolean isOne = meeting.get("a").asText().equals(playerId) && meeting.get("b").asText().equals(opponentId);
                boolean isTwo = meeting.get("a").asText().equals(opponentId) && meeting.get("b").asText().equals(playerId);
                if (!isOne && !isTwo) continue;
                points += isOne ? meeting.get("pointsA").asLong() : meeting.get("pointsB").asLong();
                against += isOne ? meeting.get("pointsB").asLong() : meeting.get("pointsA").asLong();
                JsonNode winner = meeting.get("winner");
                if (winner == null || winner.isNull()) continue;   // a draw counts for neither
                if (winner.asText().equals(playerId)) { wins++; diff += meeting.get("diff").asLong(); }
                else if (winner.asText().equals(opponentId)) { wins--; diff -= meeting.get("diff").asLong(); }
            }
            Verdict result = wins != 0 ? sign(wins) : diff != 0 ? sign(diff) : sign(points - against);
            cache.put(key, forward ? result : flip(result));
            return result;
        }

        private static Verdict sign(long value) {
            return value > 0 ? Verdict.BETTER : value < 0 ? Verdict.WORSE : Verdict.TIED;
        }

        private static Verdict flip(Verdict verdict) {
            return verdict == Verdict.BETTER ? Verdict.WORSE : verdict == Verdict.WORSE ? Verdict.BETTER : Verdict.TIED;
        }
    }
}
