package com.ctwe.tournament.web.dto;

import com.ctwe.tournament.application.publicsnapshot.PublicSnapshotState;
import com.ctwe.tournament.application.publicsnapshot.SnapshotApprovalService;

import java.time.Instant;
import java.util.List;

/**
 * Wire shapes for the Public Snapshot admin API.
 *
 * <p>Kept out of the controller so the approval request — which carries a password — has one
 * declared shape that is easy to find and review.
 */
public final class PublicSnapshotDtos {

    private PublicSnapshotDtos() {}

    /**
     * Approving publication (architecture §4.4).
     *
     * <p>Three fields, three different guards: {@code password} re-authenticates the human,
     * {@code tournamentName} must be retyped so the wrong row cannot be approved by a mis-click, and
     * {@code acknowledgmentRev} is the revision of the consent text the client actually displayed —
     * the server refuses anything but the current one, so recorded consent always matches shown
     * wording.
     */
    public record ApproveRequest(String password, String tournamentName, Short acknowledgmentRev) {

        public SnapshotApprovalService.ApprovalRequest toApprovalRequest() {
            return new SnapshotApprovalService.ApprovalRequest(password, tournamentName, acknowledgmentRev);
        }
    }

    /** What an operator needs to decide whether to publish, and what is public right now. */
    public record StatusResponse(String state, long version, Instant publishedAt, String checksum,
                                 String objectKey, String publicUrl, int cardCount,
                                 int unfinishedCardCount, boolean storageConfigured,
                                 SnapshotApprovalService.ApprovalStatus approval,
                                 List<PublicSnapshotState.Publication> history) {}
}
