"use client";

import { useEffect } from "react";
import { useTournamentStore } from "./store";

// Keep this just beyond server.servlet.session.timeout (30m). If ordinary back-office requests
// renewed the server session in the meantime, the check succeeds and the next check is scheduled;
// otherwise /api/auth/me confirms expiry and the store routes straight to /staff-login.
const SESSION_EXPIRY_CHECK_MS = 30 * 60 * 1_000 + 5_000;

/**
 * Covers staff, director, and admin pages that may sit idle without making API requests. Normal
 * API 401s are handled centrally in the store; this guard adds idle-timeout, tab-resume, browser
 * back/forward-cache, and network-recovery checks without treating an offline browser as logout.
 */
export function useBackOfficeSessionGuard() {
  const authenticated = useTournamentStore((state) => state.auth.authenticated);
  const ensureSessionAlive = useTournamentStore((state) => state.ensureSessionAlive);

  useEffect(() => {
    if (!authenticated) return;

    let checking = false;
    const check = () => {
      if (checking) return;
      checking = true;
      void ensureSessionAlive().finally(() => { checking = false; });
    };
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    const timer = window.setInterval(check, SESSION_EXPIRY_CHECK_MS);

    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    window.addEventListener("pageshow", check);
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
      window.removeEventListener("pageshow", check);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [authenticated, ensureSessionAlive]);
}
