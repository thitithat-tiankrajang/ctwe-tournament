import assert from "node:assert/strict";
import { test } from "node:test";
import { createPairingCommitKey } from "./pairing-commit-key";

test("creates a UUID v4 for a pairing commit when randomUUID is unavailable on LAN", (t) => {
  t.mock.method(crypto, "randomUUID", () => {
    throw new TypeError("crypto.randomUUID is not a function");
  });
  t.mock.method(crypto, "getRandomValues", (bytes: unknown) => {
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(bytes.length, 16);
    bytes.set([0, 1, 2, 3, 4, 5, 0xf6, 7, 0xc8, 9, 10, 11, 12, 13, 14, 15]);
    return bytes;
  });

  assert.equal(createPairingCommitKey(), "00010203-0405-4607-8809-0a0b0c0d0e0f");
});
