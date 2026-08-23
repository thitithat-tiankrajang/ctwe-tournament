/**
 * Is the viewer's identity known yet?
 *
 * `store.load()` starts with `loading: true` and `auth: anonymous`, and only resolves the real
 * identity once `/api/auth/me` answers. Reading `auth` alone during that window does not give
 * "unknown" — it gives a confident *wrong* answer: an anonymous public viewer. So the shell drew a
 * VIEWER badge, an empty nav and no logout button for a signed-in director, then repainted a moment
 * later. That is worse than a spinner: a wrong answer that looks settled invites a click.
 *
 * Purely derived — no new store field, no `set()` call, and nothing here touches the SSE patch
 * layer or the sync hooks' `loading` gate (`03_INVARIANTS.md` §1). It is a second reading of state
 * that already exists.
 */
export type AuthStatus = "unknown" | "anonymous" | "authenticated";

export interface AuthStatusInput {
  loading: boolean;
  auth: { authenticated: boolean };
}

/**
 * `loading` wins. A user who IS authenticated still reports `unknown` while the initial load is in
 * flight, because at that moment the app has not yet been told so — `auth.authenticated` is still
 * sitting at its `anonymous` default and agreeing with it would be a coincidence, not a fact.
 */
export function selectAuthStatus({ loading, auth }: AuthStatusInput): AuthStatus {
  if (loading) return "unknown";
  return auth.authenticated ? "authenticated" : "anonymous";
}

/** True while the identity is still resolving — the one condition that should render a skeleton. */
export function isAuthPending(status: AuthStatus): boolean {
  return status === "unknown";
}
