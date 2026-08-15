import assert from "node:assert/strict";
import test from "node:test";

import { shouldUseRealtime } from "./use-public-sync";

/**
 * `/api/public/realtime-config` is served by **Render**, so on the published path it must never be
 * requested — Phase D's acceptance criterion is *zero* origin requests, not "almost none".
 *
 * The trap this guards is a timing one, and it is easy to reintroduce. On a cold `/tour/{slug}` load
 * the viewer hooks mount **before** the snapshot probe resolves, so `activeTournament` is still null
 * and `published` reads `false`. A naive `useRealtimeConfig(!published)` therefore fires an origin
 * request during that window, on exactly the path whose whole purpose is to make none. The bug is
 * invisible to a store-level test, because the store never mounts the hooks.
 *
 * `shouldUseRealtime` is the predicate both hooks pass to `useRealtimeConfig`, and the matrix below
 * is every real call site: `usePublicBundleSync(token, …)` from the viewer, `usePublicSync(cardId, …)`
 * from the viewer, and `usePublicSync(id, !isStaff)` from the app shell.
 *
 * Asserted on the predicate rather than through a rendered component because the repository has no
 * DOM test harness; adding one is a larger change than this invariant warrants. What that leaves
 * unproven is only the wiring — that both hooks actually pass this predicate — which is a two-line
 * read in `use-public-sync.ts`.
 */

test("no realtime config is requested before the snapshot probe has resolved", () => {
  // usePublicBundleSync: the viewer passes enabled=false until `tournament !== null`, and the store
  // sets `published` in the same step it resolves the bundle — so the unresolved window is silent.
  assert.equal(shouldUseRealtime(false, "ctwe-2026", false), false);
  // usePublicSync on the card LIST: no card is open, so there is no stream to configure.
  assert.equal(shouldUseRealtime(true, undefined, false), false);
});

test("no realtime config is requested for a published tournament", () => {
  assert.equal(shouldUseRealtime(true, "ctwe-2026", true), false, "published card list");
  assert.equal(shouldUseRealtime(true, "card-1", true), false, "published, card open");
});

test("a live tournament still requests the realtime config when a stream is about to open", () => {
  // The live path must be unchanged in substance: the config is fetched exactly when it is needed.
  assert.equal(shouldUseRealtime(true, "ctwe-2026", false), true, "live card list");
  assert.equal(shouldUseRealtime(true, "card-1", false), true, "live, card open");
});

test("the app shell's public card page is unaffected", () => {
  // usePublicSync(id, !isStaff) with a card id present and no tournament-scoped probe in play.
  assert.equal(shouldUseRealtime(true, "card-1", false), true);
});

test("an authenticated viewer never requests the public realtime config", () => {
  // Staff hold their own /api/cards sync channel; `enabled` is false at both call sites.
  assert.equal(shouldUseRealtime(false, "card-1", false), false);
  assert.equal(shouldUseRealtime(false, undefined, false), false);
});

test("an empty target counts as absent", () => {
  assert.equal(shouldUseRealtime(true, "", false), false);
});
