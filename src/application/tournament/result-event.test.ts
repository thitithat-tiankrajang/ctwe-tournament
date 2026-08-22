import assert from "node:assert/strict";
import test from "node:test";
import { actorRoleLabels, describeActor, type StaffResultChangeEvent } from "./result-event";

/**
 * P4 SSE proof gate, fix D — contract test for the actor on the staff `result` frame.
 *
 * The payload below is the shape `CardEventPublisher.StaffResultChangeEvent` actually puts on the
 * wire; `SseDeliveryProofDatabaseTest.bLearnsWhoChangedTheResult` asserts the same bytes end to end
 * against a real login, so these two tests are deliberately coupled. If the backend record changes,
 * that test fails first and this one must be updated with it.
 */

/** Captured from the wire in the end-to-end gate run. */
const FRAME = `{"cardId":"11111111-2222-3333-4444-555555555555","version":18,`
  + `"updatedAt":"2026-08-22T09:20:00Z","changedPairings":[],`
  + `"actor":"p4-a-1a2b3c4d","actorRoles":["ROLE_DIRECTOR"]}`;

test("the actor and role survive JSON parsing exactly as the backend sent them", () => {
  const event = JSON.parse(FRAME) as StaffResultChangeEvent;

  assert.equal(event.actor, "p4-a-1a2b3c4d");
  assert.deepEqual(event.actorRoles, ["ROLE_DIRECTOR"]);
  assert.equal(event.version, 18);
  assert.equal(event.cardId, "11111111-2222-3333-4444-555555555555");
});

test("describeActor reports the account and its roles ready for display", () => {
  const event = JSON.parse(FRAME) as StaffResultChangeEvent;

  assert.deepEqual(describeActor(event), { name: "p4-a-1a2b3c4d", roles: ["DIRECTOR"] });
});

test("the ROLE_ prefix is stripped for display but never guessed at", () => {
  assert.deepEqual(actorRoleLabels({ actorRoles: ["ROLE_ADMIN", "ROLE_STAFF"] }), ["ADMIN", "STAFF"]);
  assert.deepEqual(actorRoleLabels({ actorRoles: ["CUSTOM"] }), ["CUSTOM"]);
  assert.deepEqual(actorRoleLabels({}), []);
});

test("a pre-fix-D backend omits the fields, and that reads as 'unknown', not a placeholder", () => {
  // Invariant D: New FE + Old BE must keep working. Jackson is configured non_null, so an older
  // backend sends the frame without these keys rather than with nulls.
  const legacy = JSON.parse(`{"cardId":"c","version":3,"updatedAt":"x","changedPairings":[]}`) as StaffResultChangeEvent;

  assert.equal(describeActor(legacy), null,
    "callers must handle 'we do not know who' rather than be handed an invented name");
  assert.deepEqual(actorRoleLabels(legacy), []);
});

test("an actor with no roles is still an actor", () => {
  const event = { cardId: "c", version: 1, updatedAt: "x", changedPairings: [], actor: "someone" };

  assert.deepEqual(describeActor(event), { name: "someone", roles: [] });
});
