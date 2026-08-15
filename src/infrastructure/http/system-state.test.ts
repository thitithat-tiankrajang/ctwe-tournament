import assert from "node:assert/strict";
import test from "node:test";

/**
 * The system state file, and the one property that matters about it: **it can only add an
 * explanation, never take one away.**
 *
 * Architecture §21 caveat 2 and Z8: if `system/state.json` is missing, stale, unreachable or
 * nonsense, every page must behave exactly as it does today — normal login form, normal viewer
 * messages. A state file that could lock an operator out of a running system would be worse than no
 * state file at all, so every failure path below has to end in `null`.
 *
 * §17.5 is the other half: this file is never a security control. It says what the operator
 * intends, and Spring Security remains the only thing enforcing anything.
 *
 * `system-state.ts` reads `NEXT_PUBLIC_SNAPSHOT_ORIGIN` at module load and memoizes per session, so
 * each case below imports a fresh copy with the environment already set.
 */

const FIXTURE_ORIGIN = "https://snapshot.example.com";

let moduleCounter = 0;
async function loadModule(origin: string | undefined) {
  if (origin === undefined) delete process.env.NEXT_PUBLIC_SNAPSHOT_ORIGIN;
  else process.env.NEXT_PUBLIC_SNAPSHOT_ORIGIN = origin;
  return import(`./system-state.ts?case=${moduleCounter++}`) as Promise<
    typeof import("./system-state")
  >;
}

function withFetch(handler: (url: string) => Promise<Response> | Response) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("with the snapshot origin unset, the state file is never requested", async () => {
  const { fetchSystemState } = await loadModule(undefined);
  const stub = withFetch(() => json({ state: "OFF" }));
  try {
    assert.equal(await fetchSystemState(), null);
    assert.deepEqual(stub.calls, [], "no origin means no request at all");
  } finally {
    stub.restore();
  }
});

test("a well-formed OFF state is read from the system/ prefix", async () => {
  const { fetchSystemState, systemIsOff } = await loadModule(FIXTURE_ORIGIN);
  const stub = withFetch(() => json({
    state: "OFF",
    since: "2026-08-15T00:00:00Z",
    message: "หลังจบรายการ",
    activeTournamentsAtLastCheck: 0,
  }));
  try {
    const state = await fetchSystemState();
    assert.equal(state?.state, "OFF");
    assert.equal(state?.activeTournamentsAtLastCheck, 0);
    assert.equal(systemIsOff(state), true);
    assert.deepEqual(stub.calls, [`${FIXTURE_ORIGIN}/system/state.json`],
      "system/ is a separate prefix from s/, so retraction semantics are unaffected (§17.4)");
  } finally {
    stub.restore();
  }
});

test("READY and DRAINING are not 'off' — DRAINING is a review window, not a lockdown", async () => {
  const { fetchSystemState, systemIsOff } = await loadModule(FIXTURE_ORIGIN);
  for (const state of ["READY", "DRAINING"]) {
    const stub = withFetch(() => json({ state }));
    try {
      const { resetSystemStateCache } = await loadModule(FIXTURE_ORIGIN);
      resetSystemStateCache();
      assert.equal(systemIsOff(await fetchSystemState()), false, `${state} must keep the UI normal`);
    } finally {
      stub.restore();
    }
  }
});

test("STARTING and STOPPING count as off, so the login form is not offered mid-transition", async () => {
  const { systemIsOff } = await loadModule(FIXTURE_ORIGIN);
  for (const state of ["OFF", "STARTING", "STOPPING"] as const) {
    assert.equal(
      systemIsOff({ state, since: null, message: null, activeTournamentsAtLastCheck: null }),
      true,
      `${state} must read as unavailable`,
    );
  }
});

/**
 * Every one of these is a way the file can betray us in production. All of them must land on the
 * same answer — `null`, meaning "say nothing, change nothing".
 */
for (const [name, handler] of [
  ["a 404 (the file was never written)", () => new Response("", { status: 404 })],
  ["a 5xx from the CDN", () => new Response("", { status: 503 })],
  ["a network failure", () => { throw new Error("connection reset"); }],
  ["malformed JSON", () => new Response("{not json", { status: 200 })],
  ["a body that is not an object", () => json("OFF")],
  ["a missing state field", () => json({ since: "2026-08-15T00:00:00Z" })],
  ["an unknown state name", () => json({ state: "PANIC" })],
] as const) {
  test(`${name} fails toward available`, async () => {
    const { fetchSystemState, systemIsOff } = await loadModule(FIXTURE_ORIGIN);
    const stub = withFetch(handler as () => Response);
    try {
      const state = await fetchSystemState();
      assert.equal(state, null, "an unreadable state file must never assert anything");
      assert.equal(systemIsOff(state), false, "and must never make a running system look off");
    } finally {
      stub.restore();
    }
  });
}

test("the answer is memoized, so a page with several readers makes one request", async () => {
  const { fetchSystemState } = await loadModule(FIXTURE_ORIGIN);
  const stub = withFetch(() => json({ state: "OFF" }));
  try {
    await fetchSystemState();
    await fetchSystemState();
    await fetchSystemState();
    assert.equal(stub.calls.length, 1, "the file carries max-age=30 of its own");
  } finally {
    stub.restore();
  }
});

test("a stray field cannot smuggle a value into the parsed state", async () => {
  const { fetchSystemState } = await loadModule(FIXTURE_ORIGIN);
  const stub = withFetch(() => json({
    state: "OFF",
    since: 12345,
    message: { nested: true },
    activeTournamentsAtLastCheck: "many",
  }));
  try {
    const state = await fetchSystemState();
    assert.equal(state?.state, "OFF");
    assert.equal(state?.since, null, "wrong-typed fields are dropped, not passed through");
    assert.equal(state?.message, null);
    assert.equal(state?.activeTournamentsAtLastCheck, null);
  } finally {
    stub.restore();
  }
});
