package com.ctwe.tournament.infrastructure.security;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.provisioning.JdbcUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.util.matcher.AntPathRequestMatcher;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;

@Configuration
public class SecurityConfiguration {
    @Bean
    UserDetailsService staffUsers(DataSource dataSource) {
        var manager = new JdbcUserDetailsManager(dataSource);
        manager.setUsersByUsernameQuery("""
            SELECT username, password_hash, (enabled AND (locked_until IS NULL OR locked_until < now()))
            FROM staff_accounts WHERE username = ?
            """);
        manager.setAuthoritiesByUsernameQuery("SELECT username, authority FROM staff_authorities WHERE username = ?");
        return manager;
    }

    @Bean
    ApplicationRunner bootstrapStaffAccount(
        JdbcTemplate jdbc,
        @Value("${security.staff.username}") String username,
        @Value("${security.staff.password-hash}") String passwordHash
    ) {
        return args -> {
            if (!username.matches("^[A-Za-z0-9_.@-]{3,64}$")) throw new IllegalStateException("Invalid STAFF_USERNAME");
            if (!passwordHash.matches("^\\$2[aby]\\$1[2-9]\\$.*"))
                throw new IllegalStateException("STAFF_PASSWORD_HASH must be BCrypt cost 12 or higher");
            jdbc.update("""
                INSERT INTO staff_accounts (username, password_hash, enabled)
                VALUES (?, ?, true) ON CONFLICT (username) DO NOTHING
                """, username, "{bcrypt}" + passwordHash);
            jdbc.update("""
                INSERT INTO staff_authorities (username, authority)
                VALUES (?, 'ROLE_STAFF') ON CONFLICT DO NOTHING
                """, username);
        };
    }

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        var csrfRepository = CookieCsrfTokenRepository.withHttpOnlyFalse();
        csrfRepository.setCookiePath("/");

        return http
            .csrf(csrf -> csrf.csrfTokenRepository(csrfRepository))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/actuator/health", "/api/auth/me", "/staff-login", "/login").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/cards/*/audit").hasRole("STAFF")
                .requestMatchers(HttpMethod.GET, "/api/cards", "/api/cards/**").permitAll()
                .requestMatchers("/api/dev/**").hasRole("STAFF")
                .requestMatchers("/api/**").hasRole("STAFF")
                .anyRequest().permitAll())
            .formLogin(form -> form
                .loginPage("/staff-login")
                .loginProcessingUrl("/login")
                .successHandler((request, response, authentication) -> response.setStatus(HttpStatus.NO_CONTENT.value()))
                .failureHandler((request, response, exception) -> response.sendError(HttpStatus.UNAUTHORIZED.value()))
                .permitAll())
            .logout(logout -> logout
                .logoutRequestMatcher(new AntPathRequestMatcher("/logout", "POST"))
                .logoutSuccessHandler((request, response, authentication) -> response.setStatus(HttpStatus.NO_CONTENT.value()))
                .invalidateHttpSession(true)
                .deleteCookies("JSESSIONID"))
            .exceptionHandling(exceptions -> exceptions.defaultAuthenticationEntryPointFor(
                new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED), new AntPathRequestMatcher("/api/**")))
            .headers(headers -> headers
                .contentSecurityPolicy(csp -> csp.policyDirectives("default-src 'none'; frame-ancestors 'none'"))
                .frameOptions(frame -> frame.deny())
                .contentTypeOptions(content -> {}))
            .sessionManagement(session -> session
                .sessionFixation(fixation -> fixation.migrateSession())
                .maximumSessions(2))
            .build();
    }
}
