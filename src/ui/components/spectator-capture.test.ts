import assert from "node:assert/strict";
import test from "node:test";
import {
  beginSpectatorCapture,
  endSpectatorCapture,
  spectatorCapturePresentation,
} from "./spectator-capture";

test("Memory capture enters fullscreen before requesting landscape", async () => {
  const calls: string[] = [];
  const root = {
    requestFullscreen: async () => { calls.push("fullscreen"); },
  };
  const orientation = {
    lock: async (value: "landscape") => { calls.push(`orientation:${value}`); },
  };

  const result = await beginSpectatorCapture(root, orientation);

  assert.deepEqual(calls, ["fullscreen", "orientation:landscape"]);
  assert.deepEqual(result, { fullscreen: "succeeded", orientation: "succeeded" });
});

test("Memory capture reports an unavailable fullscreen API without attempting orientation lock", async () => {
  let lockCalls = 0;
  const result = await beginSpectatorCapture({}, {
    lock: async () => { lockCalls += 1; },
  });

  assert.deepEqual(result, { fullscreen: "unsupported", orientation: "skipped" });
  assert.equal(lockCalls, 0);
});

test("Memory capture reports fullscreen rejection without throwing", async () => {
  const result = await beginSpectatorCapture({
    requestFullscreen: async () => { throw new Error("not allowed"); },
  }, {
    lock: async () => { throw new Error("must not run"); },
  });

  assert.deepEqual(result, { fullscreen: "rejected", orientation: "skipped" });
});

test("Memory capture reports orientation rejection after fullscreen succeeds", async () => {
  const result = await beginSpectatorCapture({
    requestFullscreen: async () => {},
  }, {
    lock: async () => { throw new Error("orientation unavailable"); },
  });

  assert.deepEqual(result, { fullscreen: "succeeded", orientation: "rejected" });
});

test("Memory capture distinguishes the rotate fallback from the finished record", () => {
  assert.equal(spectatorCapturePresentation(390, 844), "rotate");
  assert.equal(spectatorCapturePresentation(844, 390), "record");
  assert.equal(spectatorCapturePresentation(932, 430), "record");
});

test("Memory capture exit unlocks orientation before leaving fullscreen", async () => {
  const calls: string[] = [];
  await endSpectatorCapture({
    fullscreenElement: {},
    exitFullscreen: async () => { calls.push("exit-fullscreen"); },
  }, {
    unlock: () => { calls.push("unlock-orientation"); },
  });

  assert.deepEqual(calls, ["unlock-orientation", "exit-fullscreen"]);
});

test("Memory capture exit remains safe when neither optional API is available", async () => {
  await assert.doesNotReject(() => endSpectatorCapture({ fullscreenElement: null }, {}));
});
