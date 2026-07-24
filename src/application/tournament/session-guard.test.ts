import assert from "node:assert/strict";
import test from "node:test";
import { useTournamentStore, type AuthState } from "./store";

const roles = ["ROLE_STAFF", "ROLE_DIRECTOR", "ROLE_ADMIN"] as const;

function authenticated(role: typeof roles[number]): AuthState {
  return { authenticated: true, username: role.toLowerCase(), roles: [role], csrfToken: "csrf" };
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

test("confirmed session loss redirects staff, director, and admin to login", async () => {
  const browser = installBrowser();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    authenticated: false,
    username: null,
    roles: [],
    csrfToken: "fresh-csrf",
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    for (const role of roles) {
      browser.redirects.length = 0;
      useTournamentStore.setState({
        auth: authenticated(role),
        cards: [{ id: "sensitive-card" }] as never,
        activeTournament: { id: "tournament", name: "Tournament" },
      });

      await useTournamentStore.getState().ensureSessionAlive();

      assert.deepEqual(browser.redirects, ["/staff-login?expired=1"], role);
      assert.equal(useTournamentStore.getState().auth.authenticated, false, role);
      assert.deepEqual(useTournamentStore.getState().cards, [], role);
      assert.equal(useTournamentStore.getState().activeTournament, null, role);
    }
  } finally {
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});

test("a network failure does not masquerade as an expired session", async () => {
  const browser = installBrowser("/admin");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  useTournamentStore.setState({ auth: authenticated("ROLE_ADMIN") });

  try {
    await useTournamentStore.getState().ensureSessionAlive();

    assert.equal(useTournamentStore.getState().auth.authenticated, true);
    assert.deepEqual(browser.redirects, []);
  } finally {
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});

test("a wrong confirmation password does not masquerade as an expired session", async () => {
  const browser = installBrowser("/admin");
  const originalFetch = globalThis.fetch;
  let requestNumber = 0;
  globalThis.fetch = async () => {
    requestNumber += 1;
    if (requestNumber === 1) {
      return new Response(JSON.stringify({ error: "รหัสผ่านไม่ถูกต้อง" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(authenticated("ROLE_ADMIN")), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  useTournamentStore.setState({ auth: authenticated("ROLE_ADMIN") });

  try {
    await assert.rejects(
      useTournamentStore.getState().setTournamentStatus("tournament", false, "wrong-password"),
      /รหัสผ่านไม่ถูกต้อง/,
    );

    assert.equal(requestNumber, 2);
    assert.equal(useTournamentStore.getState().auth.authenticated, true);
    assert.deepEqual(browser.redirects, []);
  } finally {
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});
