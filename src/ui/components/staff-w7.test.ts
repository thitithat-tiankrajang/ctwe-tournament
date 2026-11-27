import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { operatorStageLabels } from "./stage-info";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("staff workflow stages distinguish pairing, entry, review, and publication", () => {
  assert.equal(operatorStageLabels.TABLE_PAIRING, "รอสร้างคู่แข่งขัน");
  assert.equal(operatorStageLabels.PAIRING_PREVIEW, "ตรวจและยืนยันคู่แข่งขัน");
  assert.equal(operatorStageLabels.RESULT_COLLECTION, "กรอกผลการแข่งขัน");
  assert.equal(operatorStageLabels.RESULT_REVIEW, "ตรวจผลก่อนเผยแพร่");
  assert.notEqual(operatorStageLabels.RESULT_COLLECTION, operatorStageLabels.RESULT_REVIEW);
});

test("director pairing page puts the direct swap above the preview table", () => {
  const source = read("src/app/cards/[id]/tables/page.tsx");
  const preview = source.indexOf('aria-label="ตารางคู่แข่งขัน"');
  const controls = source.indexOf("<DirectPlayerSwap");
  assert.ok(preview >= 0, "pairing preview panel should be present");
  assert.ok(controls >= 0, "the inline swap should be present");
  assert.doesNotMatch(source, /<details[^>]*preview-swap/);
  assert.ok(controls < preview, "the inline swap should stay with its preview table");
});

test("result entry keeps recording, review, and publication as distinct actions", () => {
  const source = read("src/app/cards/[id]/games/page.tsx");
  assert.match(source, /reviewing \? \(isDirector \? "ตรวจผลการแข่งขัน" : "ผู้อำนวยการกำลังตรวจผล"\)/);
  assert.match(source, />ตรวจผล <ArrowRight/);
  assert.match(source, /เผยแพร่ผล \{blockLabel\}<\/Button>/);
  assert.match(source, /เผยแพร่คู่แข่งขัน เกม/);
  assert.match(source, /ResultEntryGrid/);
  assert.doesNotMatch(source, /คู่แข่งขันของเกมที่กำลังกรอกผล/);
});

test("conflict acknowledgement explains draft handling before continuing", () => {
  const source = read("src/ui/components/result-entry-grid.tsx");
  assert.match(source, /ทิ้งค่าที่กรอกค้างไว้/);
  assert.match(source, /ใช้ผลปัจจุบัน/);
});
