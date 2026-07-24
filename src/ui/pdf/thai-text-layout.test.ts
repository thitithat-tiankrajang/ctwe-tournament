import assert from "node:assert/strict";
import test from "node:test";

import {
  needsThaiClusterLayout,
  thaiClusters,
  thaiMarkAnchorX,
  thaiMarkOffsets,
} from "./thai-text-layout";

function markedCluster(value: string) {
  const cluster = thaiClusters(value).find((item) => item.upper.length > 0 || item.tone.length > 0 || item.lower.length > 0);
  assert.ok(cluster, `expected a marked Thai cluster in ${value}`);
  return cluster;
}

test("groups upper vowels and tone marks with the same Thai base", () => {
  const cases = [
    ["มั่น", "ม", ["ั"], ["่"], ""],
    ["ชั้น", "ช", ["ั"], ["้"], ""],
    ["ที่", "ท", ["ี"], ["่"], ""],
    ["ผึ้ง", "ผ", ["ึ"], ["้"], ""],
    ["ธิ์", "ธ", ["ิ"], ["์"], ""],
    ["น้ำ", "น", ["ํ"], ["้"], "า"],
  ] as const;

  for (const [value, base, upper, tone, suffix] of cases) {
    const cluster = markedCluster(value);
    assert.equal(cluster.base, base);
    assert.deepEqual(cluster.upper, upper);
    assert.deepEqual(cluster.tone, tone);
    assert.equal(cluster.suffix, suffix);
  }
});

test("lifts a tone above an upper vowel but leaves a tone-only cluster at its normal level", () => {
  const stacked = markedCluster("มั่น");
  const toneOnly = markedCluster("เก่ง");
  assert.ok(thaiMarkOffsets(stacked, 9.4).tone[0] <= -2.8);
  assert.equal(thaiMarkOffsets(toneOnly, 9.4).tone[0], 0);
});

test("detects text that must use custom Thai cluster layout", () => {
  assert.equal(needsThaiClusterLayout("A012 วายุ จิตต์มั่น"), true);
  assert.equal(needsThaiClusterLayout("โรงเรียนสายน้ำผึ้ง"), true);
  assert.equal(needsThaiClusterLayout("A012 Wayo"), false);
});

test("anchors combining marks at the font pen after the Thai base glyph", () => {
  assert.equal(thaiMarkAnchorX(100, 4, 8), 112);
  assert.notEqual(thaiMarkAnchorX(100, 4, 8), 108);
});
