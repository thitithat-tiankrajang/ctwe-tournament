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

test("director pairing page presents preview evidence before manipulation controls", () => {
  const source = read("src/app/cards/[id]/tables/page.tsx");
  const preview = source.indexOf('className="pairing-preview-panel"');
  const controls = source.indexOf('<Panel title="ปรับคู่ผู้เล่น"');
  assert.ok(preview >= 0, "pairing preview panel should be present");
  assert.ok(controls >= 0, "pairing manipulation panel should be present");
  assert.ok(preview < controls, "operators should see evidence before editing controls");
});

test("result entry keeps recording, review, and publication as distinct actions", () => {
  const source = read("src/app/cards/[id]/games/page.tsx");
  assert.match(source, /title=\{reviewing \? "ตรวจผลการแข่งขัน"/);
  assert.match(source, />ตรวจผล <ArrowRight/);
  assert.match(source, /เผยแพร่ผล<\/Button>/);
  assert.match(source, /เผยแพร่คู่แข่งขัน เกม/);
  assert.match(source, /operator-state-strip/);
});

test("conflict acknowledgement explains draft handling before continuing", () => {
  const source = read("src/ui/components/result-entry-grid.tsx");
  assert.match(source, /ทิ้งค่าที่กรอกค้างไว้/);
  assert.match(source, /ใช้ผลปัจจุบัน/);
});
