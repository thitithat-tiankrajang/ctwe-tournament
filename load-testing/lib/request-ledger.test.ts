import assert from "node:assert/strict";
import test from "node:test";

import { classifyDestination, destinationMap } from "./request-ledger.js";

/**
 * Destination classification.
 *
 * Everything Phase H ② asserts rests on this function: an origin request that is classified as
 * anything else disappears from the count, and the zero-Render claim becomes unfalsifiable. So the
 * cases below are the ones where a mistake would be invisible — a shared host, a different port, a
 * scheme mismatch, and a URL that cannot be parsed at all.
 */

const map = destinationMap(
  new URL("https://api.example.onrender.com"),
  new URL("https://api.example.onrender.com"),
  new URL("https://snapshot.ct-we.com"),
);

test("Render, the CDN and the Worker are told apart", () => {
  assert.equal(classifyDestination("https://api.example.onrender.com/api/public/x/bundle", map), "origin");
  assert.equal(classifyDestination("https://snapshot.ct-we.com/s/abc.json", map), "cdn");
  assert.equal(classifyDestination("https://ct-we.com/tour/my-cup", map), "frontend");
});

test("a separate metrics host is still Render", () => {
  const split = destinationMap(
    new URL("https://public.example.com"),
    new URL("https://admin.example.com"),
    new URL("https://snapshot.ct-we.com"),
  );
  assert.equal(classifyDestination("https://public.example.com/api/public/realtime-config", split), "origin");
  assert.equal(classifyDestination("https://admin.example.com/actuator/metrics/x", split), "origin");
});

test("a port or scheme difference is a different origin, not the same one", () => {
  const local = destinationMap(
    new URL("http://127.0.0.1:8080"),
    new URL("http://127.0.0.1:8080"),
    new URL("http://127.0.0.1:9000"),
  );
  assert.equal(classifyDestination("http://127.0.0.1:8080/api/public/x/bundle", local), "origin");
  assert.equal(classifyDestination("http://127.0.0.1:9000/s/abc.json", local), "cdn");
  assert.equal(classifyDestination("http://127.0.0.1:3000/tour/my-cup", local), "frontend");
  assert.equal(classifyDestination("https://127.0.0.1:8080/api/public/x/bundle", local), "frontend");
});

test("a snapshot host collocated on Render counts as Render", () => {
  // The pessimistic reading. If someone points SNAPSHOT_ORIGIN at the backend, the probe really is
  // an origin request and ② must fail rather than credit the CDN with work Render did.
  const collocated = destinationMap(
    new URL("https://api.example.onrender.com"),
    new URL("https://api.example.onrender.com"),
    new URL("https://api.example.onrender.com"),
  );
  assert.equal(classifyDestination("https://api.example.onrender.com/s/abc.json", collocated), "origin");
});

test("the page document is charged to Render when the frontend shares its host", () => {
  const shared = destinationMap(
    new URL("http://localhost:8080"),
    new URL("http://localhost:8080"),
    null,
  );
  assert.equal(classifyDestination("http://localhost:8080/tour/my-cup", shared), "origin");
});

test("an unparseable URL is charged to Render rather than ignored", () => {
  assert.equal(classifyDestination("not a url", map), "origin");
});

test("with no CDN configured nothing is ever classified as cdn", () => {
  const noCdn = destinationMap(
    new URL("https://api.example.onrender.com"),
    new URL("https://api.example.onrender.com"),
    null,
  );
  assert.equal(classifyDestination("https://snapshot.ct-we.com/s/abc.json", noCdn), "frontend");
});
