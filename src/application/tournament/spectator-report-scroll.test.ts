import assert from "node:assert/strict";
import test from "node:test";
import { attemptReportScroll, createReportScrollOwner } from "./spectator-report-scroll";

const CARD_A = "0814c9db-56ef-466f-a658-66c7fe35f1f7";
const CARD_B = "af6273df-acc8-426a-9a87-a429ad400deb";

test("report POP owns scroll 900 through effect cleanup and clears only after restoration succeeds", () => {
  const owner = createReportScrollOwner();
  const target = owner.stage(CARD_A, 900);

  // An effect setup may be cleaned up before its frame. Cleanup performs no owner transition.
  assert.deepEqual(owner.targetFor(CARD_A), target);

  let actualScroll = 0;
  assert.equal(attemptReportScroll(owner, target, 1800, () => {}, () => actualScroll), "pending");
  assert.deepEqual(owner.targetFor(CARD_A), target, "a failed attempt must retain its target");

  assert.equal(attemptReportScroll(owner, target, 1800, (value) => { actualScroll = value; }, () => actualScroll), "complete");
  assert.equal(actualScroll, 900);
  assert.equal(owner.targetFor(CARD_A), null);
});

test("nested Player history does not consume the report target before the final report POP", () => {
  const owner = createReportScrollOwner();
  assert.equal(owner.targetFor(CARD_A), null, "forward Player A and Player B entries own no report restoration");

  const target = owner.stage(CARD_A, 900);
  let actualScroll = 0;
  assert.equal(attemptReportScroll(owner, target, 1800, (value) => { actualScroll = value; }, () => actualScroll), "complete");
  assert.equal(actualScroll, 900);
});

test("report restoration remains scoped to the history entry's card", () => {
  const owner = createReportScrollOwner();
  owner.stage(CARD_A, 900);
  assert.equal(owner.targetFor(CARD_B), null);
  assert.equal(owner.targetFor(CARD_A)?.scrollY, 900);
});

test("leaving before restoration cancels ownership and prevents a stale jump", () => {
  const owner = createReportScrollOwner();
  const staleTarget = owner.stage(CARD_A, 900);
  owner.cancel();

  let calls = 0;
  assert.equal(attemptReportScroll(owner, staleTarget, 1800, () => { calls += 1; }, () => 0), "stale");
  assert.equal(calls, 0);
  assert.equal(owner.complete(staleTarget.id), false);
});

test("a shorter realtime report restores to its reachable clamp", () => {
  const owner = createReportScrollOwner();
  const target = owner.stage(CARD_A, 900);
  let actualScroll = 0;
  assert.equal(attemptReportScroll(owner, target, 640, () => { actualScroll = 640; }, () => actualScroll), "complete");
  assert.equal(owner.targetFor(CARD_A), null);
});
