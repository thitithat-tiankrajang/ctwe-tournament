import assert from "node:assert/strict";
import test from "node:test";

import { snapshotKey, snapshotUrl } from "./snapshot-key.js";

/**
 * SHARED FIXTURE VECTORS — byte-identical to `SnapshotKeyTest.java` and `snapshot-api.test.ts`.
 *
 * There are now three implementations of this derivation: the backend that writes the object, the
 * browser that reads it, and this load generator that has to request exactly what the browser would.
 * If the generator drifted, every probe would 404, every published viewer would fail open onto the
 * live path, and Phase H would report a "published fleet" that never touched a snapshot — while this
 * file's own arithmetic still agreed with itself. Hence literal expected values, not recomputation.
 */
const VECTORS: Array<[string, string]> = [
  ["bkk-th-ms-championship", "hcjbazc3ehzb4pip6gueijdxv3"],
  ["ctwe", "hh3rgn6lnfxvhmc27hsgfzeiay"],
  ["a1b", "7jpknkgoln7kuq4ay3uvfj2kdo"],
  ["7f3c1d9e2a4b5c6d8e0f1a2b3c4d5e6f", "xjlkx6owtl3czp4dfbfqel5n67"],
  ["a".repeat(64), "qeo5fga7l3m5xotlstwh2fscwm"],
];

test("the load generator derives the same key as the backend and the browser", () => {
  for (const [token, expected] of VECTORS) {
    assert.equal(snapshotKey(token), expected, `vector mismatch for "${token.slice(0, 24)}"`);
  }
});

test("keys are 26 lowercase base32 characters", () => {
  for (const [token] of VECTORS) {
    assert.match(snapshotKey(token), /^[a-z2-7]{26}$/);
  }
});

test("the domain separator is part of the digest", () => {
  // A digest of the bare token must not collide with a snapshot key.
  assert.notEqual(snapshotKey("ctwe"), snapshotKey("ctwe-public-snapshot-v1|ctwe"));
});

test("the probe URL is the single public object for the token", () => {
  assert.equal(
    snapshotUrl(new URL("https://snapshot.ct-we.com"), "ctwe"),
    "https://snapshot.ct-we.com/s/hh3rgn6lnfxvhmc27hsgfzeiay.json",
  );
  // A trailing path on the origin must not end up inside the key path.
  assert.equal(
    snapshotUrl(new URL("https://snapshot.ct-we.com/"), "a1b"),
    "https://snapshot.ct-we.com/s/7jpknkgoln7kuq4ay3uvfj2kdo.json",
  );
});
