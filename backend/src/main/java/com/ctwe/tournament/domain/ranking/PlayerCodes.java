package com.ctwe.tournament.domain.ranking;

/**
 * Ordering for player codes.
 *
 * Codes carry a per-card letter prefix (A, B, ..., AA; or the legacy P) followed by a number, so a
 * plain string compare puts A1000 before A999. This is the deterministic last resort of the INTERNAL
 * ranking order — never a displayed tie-break, and never a sporting rule.
 */
public final class PlayerCodes {
    private PlayerCodes() {}

    public static int compare(String first, String second) {
        Long firstNumber = numeric(first);
        Long secondNumber = numeric(second);
        if (firstNumber != null && secondNumber != null) {
            int byNumber = Long.compare(firstNumber, secondNumber);
            if (byNumber != 0) return byNumber;
        }
        return first.compareTo(second);
    }

    private static Long numeric(String playerId) {
        if (playerId == null || playerId.isBlank()) return null;
        String value = playerId.replaceFirst("^[A-Za-z]+", "");
        if (value.isBlank()) return null;
        for (int index = 0; index < value.length(); index++)
            if (!Character.isDigit(value.charAt(index))) return null;
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException ignored) {
            return null;
        }
    }
}
