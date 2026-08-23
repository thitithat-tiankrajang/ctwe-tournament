import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { isAuthPending, selectAuthStatus } from "./auth-status";

/**
 * The navbar must never state an identity it has not been told.
 *
 * Before this, every navigation surface read `auth` directly. During the initial `load()` that
 * object is still the `anonymous` default, so a signed-in director saw a VIEWER badge, an empty
 * nav and no logout button until `/api/auth/me` answered — a wrong answer that looks settled.
 */

test("an authenticated user still reads unknown while the load is in flight", () => {
  // The trap this exists to close: `auth.authenticated` is false here because nothing has been
  // fetched yet, NOT because the user is anonymous. Agreeing with it would be a coincidence.
  assert.equal(selectAuthStatus({ loading: true, auth: { authenticated: false } }), "unknown");
  // Even if a stale truthy value were present, loading still wins.
  assert.equal(selectAuthStatus({ loading: true, auth: { authenticated: true } }), "unknown");
});

test("a settled load reports the identity it was given", () => {
  assert.equal(selectAuthStatus({ loading: false, auth: { authenticated: true } }), "authenticated");
  assert.equal(selectAuthStatus({ loading: false, auth: { authenticated: false } }), "anonymous");
});

test("only unknown is pending", () => {
  assert.equal(isAuthPending("unknown"), true);
  assert.equal(isAuthPending("anonymous"), false);
  assert.equal(isAuthPending("authenticated"), false);
});

test("logging out lands on anonymous, not back on unknown", () => {
  // store.logout() sets { auth: anonymous, loading: false } in one go. If that briefly read as
  // unknown, the shell would flash a skeleton on the way to the login page.
  assert.equal(selectAuthStatus({ loading: false, auth: { authenticated: false } }), "anonymous");
});

test("the sync hooks' loading gate is left exactly as it was", () => {
  // 03_INVARIANTS.md §1 freezes the sync hooks and pre-agreed exactly one exception: gating
  // CardSyncHost on `!loading`. authStatus is for rendering only and must never reach them, or a
  // staff member briefly opens the PUBLIC SSE stream before the staff one.
  const shell = readFileSync(join(process.cwd(), "src", "ui", "layout", "app-shell.tsx"), "utf8");
  assert.match(shell, /useCardSync\(!loading && isStaff \? cardId : undefined\)/);
  assert.match(shell, /usePublicSync\(loading \? undefined : cardId, !isStaff\)/);
  assert.match(shell, /useFullCard\(cardId, !loading && isStaff\)/);
  assert.match(shell, /<CardSyncHost cardId=\{id\} isStaff=\{isStaff\} loading=\{loading\} \/>/);
  const host = /function CardSyncHost\([\s\S]*?\n\}/.exec(shell);
  assert.ok(host, "CardSyncHost not found");
  assert.ok(!/authStatus|selectAuthStatus|isAuthPending/.test(host[0]), "authStatus must not reach the sync hooks");
});
