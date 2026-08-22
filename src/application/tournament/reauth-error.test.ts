import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, BAD_PASSWORD, isBadPassword, useTournamentStore, type AuthState } from "./store";

/**
 * The re-authentication error contract, frontend half (B2).
 *
 * The backend answers a wrong confirmation password with `403` + `code: "BAD_PASSWORD"` and the Thai
 * message (P1-A, `10_P1_CLOSURE.md` §6). These tests pin the two properties the frontend needs
 * before the pre-flight `verifyPassword` can be removed:
 *
 *   1. the message survives all the way to the caller, so a director sees Thai and not "Unauthorized";
 *   2. `code` — never the status — is what identifies a wrong password, because a rejected CSRF token
 *      is also a 403 and must not be reported as a typo.
 */

function authenticated(): AuthState {
  return { authenticated: true, username: "director", roles: ["ROLE_DIRECTOR"], csrfToken: "csrf" };
}

function installBrowser(pathname = "/cards/card-id") {
  const redirects: string[] = [];
  let cookie = "CTWE_STAFF=1; XSRF-TOKEN=csrf";
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { pathname, replace: (url: string) => redirects.push(url) },
      localStorage: { removeItem: () => undefined },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get cookie() { return cookie; },
      set cookie(value: string) { cookie = value; },
    },
  });

  return {
    redirects,
    restore() {
      if (originalWindow === undefined) delete (globalThis as { window?: Window }).window;
      else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
      if (originalDocument === undefined) delete (globalThis as { document?: Document }).document;
      else Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
    },
  };
}

/** The exact body P1-A's ApiExceptionHandler writes. */
function badPasswordResponse() {
  return new Response(JSON.stringify({
    timestamp: "2026-08-22T00:00:00Z",
    status: 403,
    error: "รหัสผ่านไม่ถูกต้อง",
    code: BAD_PASSWORD,
  }), { status: 403, headers: { "Content-Type": "application/json" } });
}

/** Spring's default AccessDeniedHandler body: same status, no `code`. */
function csrfRejectionResponse() {
  return new Response(JSON.stringify({
    timestamp: "2026-08-22T00:00:00Z",
    status: 403,
    error: "Forbidden",
    path: "/api/cards/x/tables/swap",
  }), { status: 403, headers: { "Content-Type": "application/json" } });
}

test("a wrong password surfaces the Thai message, tagged BAD_PASSWORD, in ONE request", async () => {
  const browser = installBrowser("/admin");
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return badPasswordResponse(); };
  useTournamentStore.setState({ auth: authenticated() });

  try {
    const failure = await useTournamentStore.getState()
      .setTournamentStatus("tournament", false, "wrong-password")
      .then(() => null, (error: unknown) => error);

    assert.ok(failure instanceof ApiError, "callers need the typed error, not a bare Error");
    assert.equal(failure.status, 403);
    assert.equal(failure.code, BAD_PASSWORD);
    assert.equal(failure.message, "รหัสผ่านไม่ถูกต้อง",
      "the message the user sees — the whole point of B2");
    assert.ok(isBadPassword(failure));

    // The pre-flight cost a second round trip and the old 401 branch cost a third. 403 skips both.
    assert.equal(requests, 1, "no /api/auth/me confirmation: 403 is not a lost session");
    assert.equal(useTournamentStore.getState().auth.authenticated, true, "403 must never log anyone out");
    assert.deepEqual(browser.redirects, []);
  } finally {
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});

test("a CSRF rejection is the same 403 and must NOT be reported as a wrong password", async () => {
  const browser = installBrowser("/admin");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => csrfRejectionResponse();
  useTournamentStore.setState({ auth: authenticated() });

  try {
    const failure = await useTournamentStore.getState()
      .setTournamentStatus("tournament", false, "right-password")
      .then(() => null, (error: unknown) => error);

    assert.ok(failure instanceof ApiError);
    assert.equal(failure.status, 403, "identical status to a wrong password");
    assert.equal(failure.code, undefined, "and no code — which is exactly what distinguishes it");
    assert.equal(isBadPassword(failure), false,
      "branching on 403 alone would tell the user their password was wrong when it was not");
    assert.equal(useTournamentStore.getState().auth.authenticated, true);
    assert.deepEqual(browser.redirects, []);
  } finally {
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});

test("isBadPassword ignores anything that is not the backend's tagged 403", () => {
  assert.equal(isBadPassword(new Error("รหัสผ่านไม่ถูกต้อง")), false,
    "message text is not evidence — only the code is");
  assert.equal(isBadPassword(new ApiError("Unauthorized", 401)), false);
  assert.equal(isBadPassword(new ApiError("รหัสผ่านไม่ถูกต้อง", 403, BAD_PASSWORD)), true);
  assert.equal(isBadPassword(undefined), false);
});
