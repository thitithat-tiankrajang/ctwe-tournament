package com.ctwe.tournament.infrastructure.persistence;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface TournamentCardRepository extends JpaRepository<TournamentCardEntity, UUID> {}
