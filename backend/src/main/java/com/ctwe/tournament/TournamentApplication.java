package com.ctwe.tournament;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class TournamentApplication {
    public static void main(String[] args) {
        SpringApplication.run(TournamentApplication.class, args);
    }
}
