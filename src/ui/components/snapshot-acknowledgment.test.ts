import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ACKNOWLEDGMENT_REV } from "./snapshot-acknowledgment";

/**
 * The acknowledgment revision is a contract spanning two languages, and it fails closed but silently
 * confusingly: the backend refuses any revision but its own, so if these two constants drift, every
 * approval in the product starts returning 409 and nobody can publish anything. The same reasoning
 * that makes `snapshotKey` parity a CI-blocking test applies here.
 *
 * Read from the Java source rather than duplicated as a literal, so this test cannot be "fixed" by
 * editing it to match a drifted value.
 */
const JAVA_SOURCE =
  "backend/src/main/java/com/ctwe/tournament/application/publicsnapshot/SnapshotApprovalService.java";

test("the acknowledgment revision matches the backend's", () => {
  const java = readFileSync(JAVA_SOURCE, "utf8");
  const declared = java.match(/ACKNOWLEDGMENT_REV\s*=\s*(\d+)\s*;/);

  assert.ok(declared, `no ACKNOWLEDGMENT_REV found in ${JAVA_SOURCE}`);
  assert.equal(
    ACKNOWLEDGMENT_REV,
    Number(declared[1]),
    "The consent text and the revision recorded against it are one contract. If the Thai/English "
      + "wording in snapshot-acknowledgment.tsx changed, bump BOTH constants in the same commit; if "
      + "it did not, do not change either.",
  );
});

test("the revision is a positive integer, so 'no revision sent' can never look valid", () => {
  assert.ok(Number.isInteger(ACKNOWLEDGMENT_REV));
  assert.ok(ACKNOWLEDGMENT_REV > 0);
});
