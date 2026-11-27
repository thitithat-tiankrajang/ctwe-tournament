package com.ctwe.tournament.infrastructure.security;

import com.ctwe.tournament.application.CardEventPublisher;
import com.ctwe.tournament.application.TenantService.StaffSessionsRevoked;
import org.springframework.security.core.session.SessionInformation;
import org.springframework.security.core.session.SessionRegistry;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionalEventListener;

import java.util.HashSet;
import java.util.Set;

@Component
public class StaffSessionRevocation {
    private final SessionRegistry sessions;
    private final CardEventPublisher cardEvents;

    public StaffSessionRevocation(SessionRegistry sessions, CardEventPublisher cardEvents) {
        this.sessions = sessions;
        this.cardEvents = cardEvents;
    }

    @TransactionalEventListener
    public void revoke(StaffSessionsRevoked change) {
        Set<String> revoked = new HashSet<>();
        for (Object principal : sessions.getAllPrincipals()) {
            if (!(principal instanceof UserDetails user) || !user.getUsername().equals(change.username())) continue;
            for (SessionInformation session : sessions.getAllSessions(principal, true)) {
                session.expireNow();
                revoked.add(session.getSessionId());
            }
        }
        if (!revoked.isEmpty()) cardEvents.disconnectStaffSessions(revoked);
    }
}
