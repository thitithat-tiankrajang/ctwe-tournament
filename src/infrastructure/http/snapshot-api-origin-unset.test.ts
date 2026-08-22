import assert from "node:assert/strict";
import test from "node:test";

/**
 * The flag-off contract: with `NEXT_PUBLIC_SNAPSHOT_ORIGIN` unset, the probe never runs and the live
 * path is byte-identical to a build that had never heard of snapshots.
 *
 * This case lives in its own file because `snapshot-api.ts` binds the origin at module load
 * (`configured`, :31). tsx compiles this package to CommonJS (no `"type": "module"`), so a query
 * string cannot key a second copy into the require cache — the environment can only differ if the
 * *process* differs, and the node test runner gives each test file its own process.
 */

test("with the origin unset, the probe never runs and no request is made", async () => {
  delete process.env.NEXT_PUBLIC_SNAPSHOT_ORIGIN;
  const { fetchSnapshotBundle, SNAPSHOT_ORIGIN } = await import("./snapshot-api");

  const previous = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    assert.equal(SNAPSHOT_ORIGIN, "");
    assert.equal(await fetchSnapshotBundle("tok-off"), null);
    assert.equal(called, false, "the live path must be byte-identical to today when the flag is off");
  } finally {
    globalThis.fetch = previous;
  }
});
