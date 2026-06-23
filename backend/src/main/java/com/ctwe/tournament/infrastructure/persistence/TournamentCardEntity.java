package com.ctwe.tournament.infrastructure.persistence;

import com.ctwe.tournament.domain.model.CardStatus;
import com.ctwe.tournament.domain.model.RuntimeStage;
import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "tournament_cards")
public class TournamentCardEntity {
    @Id private UUID id;
    @Column(nullable = false) private String name;
    @Column(nullable = false) private String division;
    @Column(name = "number_of_games", nullable = false) private int numberOfGames;
    @Enumerated(EnumType.STRING) @Column(nullable = false) private CardStatus status;
    @Enumerated(EnumType.STRING) @Column(name = "runtime_stage", nullable = false) private RuntimeStage runtimeStage;
    @Column(name = "current_game", nullable = false) private int currentGame;
    @Column(name = "created_at", nullable = false) private Instant createdAt;
    @Version private long version;

    protected TournamentCardEntity() {}
    public TournamentCardEntity(UUID id, String name, String division, int numberOfGames) {
        this.id = id; this.name = name; this.division = division; this.numberOfGames = numberOfGames;
        this.status = CardStatus.DRAFT; this.runtimeStage = RuntimeStage.PLAYER_REGISTRATION; this.currentGame = 1; this.createdAt = Instant.now();
    }
    public UUID getId() { return id; }
    public String getName() { return name; }
    public String getDivision() { return division; }
    public int getNumberOfGames() { return numberOfGames; }
    public CardStatus getStatus() { return status; }
    public RuntimeStage getRuntimeStage() { return runtimeStage; }
    public int getCurrentGame() { return currentGame; }
    public Instant getCreatedAt() { return createdAt; }
}
