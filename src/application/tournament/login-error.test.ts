import assert from "node:assert/strict";
import test from "node:test";
import { loginFailureMessage } from "./login-error";

test("401 keeps the wrong-credentials message", () => {
  assert.equal(loginFailureMessage(401, null), "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
});

test("429 with a lockout Retry-After tells the user how many minutes to wait", () => {
  assert.match(loginFailureMessage(429, "900"), /15 นาที/);
  assert.match(loginFailureMessage(429, "61"), /2 นาที/);
});

test("429 with a short Retry-After is the busy message in seconds", () => {
  assert.match(loginFailureMessage(429, "5"), /5 วินาที/);
});

test("429 without a usable Retry-After still explains itself", () => {
  assert.match(loginFailureMessage(429, null), /ถี่เกินไป/);
  assert.match(loginFailureMessage(429, "soon"), /ถี่เกินไป/);
});

test("other statuses keep the generic message with the code", () => {
  assert.equal(loginFailureMessage(500, null), "เข้าสู่ระบบไม่สำเร็จ (500)");
});
