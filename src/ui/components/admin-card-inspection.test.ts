import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { inspectCard } from "@/domain/tournament/card-inspection";
import { gameOnePreviewFixture, inspectionFixture } from "@/application/tournament/fixtures/card-inspection-fixture";
import { AdminCardInspectionView } from "@/ui/components/admin-card-inspection";

Object.assign(globalThis, { React });

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

function filesUnder(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(join(root, path)).isDirectory() ? filesUnder(path) : [path];
  });
}

const render = (closed = false) => renderToStaticMarkup(React.createElement(AdminCardInspectionView, {
  state: inspectCard(inspectionFixture()),
  tournament: { kind: "ready", name: closed ? "Closed Cup" : "Open Cup", status: closed ? "CLOSED" : "OPEN" },
}));

test("ADMIN view shows the real fixture values: per-game maxDiff and rules", () => {
  const html = render();
  for (const value of ["250", "400", "175"]) assert.match(html, new RegExp(`data-max-diff="true">${value}<`));
  assert.match(html, /Random \(เกมแรก\)/);
  assert.match(html, /Swiss/);
  assert.match(html, /King of the Hill/);
  assert.match(html, /RESULT_COLLECTION/);
  assert.match(html, /2 \/ 3/, "current game / total games");
  assert.match(html, /ชิงที่ 1 และ 3 · 3 เกม/);
  assert.match(html, /ที่นั่ง/, "slot label SEAT");
  assert.match(html, /ยืนยันผลแล้ว/);
  assert.match(html, /เผยแพร่การจับคู่แล้ว/);
  assert.match(html, /ยังไม่มีการจับคู่/);
});

test("OPEN and CLOSED tournaments both render readable status", () => {
  assert.match(render(false), /Open Cup.*เปิด \(OPEN\)/);
  assert.match(render(true), /Closed Cup.*ปิด \(CLOSED\)/);
});

test("tournament metadata failure is shown as an error, not as missing data or loading", () => {
  const html = renderToStaticMarkup(React.createElement(AdminCardInspectionView, {
    state: inspectCard(inspectionFixture()), tournament: { kind: "error" },
  }));
  assert.match(html, /โหลดข้อมูลรายการแข่งขันไม่สำเร็จ/);
});

test("game-1 seat draft renders its pairs, the bye, and is marked unconfirmed", () => {
  const html = renderToStaticMarkup(React.createElement(AdminCardInspectionView, {
    state: inspectCard(gameOnePreviewFixture(7)), tournament: { kind: "ready", name: "Open Cup", status: "OPEN" },
  }));
  assert.match(html, /ร่าง · ยังไม่เผยแพร่/);
  assert.match(html, /รายละเอียดการจับคู่ เกม 1 \(4 คู่\) · ร่างจากการจัดโต๊ะ ยังไม่ยืนยัน/);
  assert.match(html, /<td>A007<\/td><td>บาย<\/td>/);
  for (const tag of ["<button", "<input", "<form", "<select", "<textarea", "<a "]) assert.equal(html.includes(tag), false);
});

test("inspection renders no controls at all", () => {
  const html = render();
  for (const tag of ["<button", "<input", "<form", "<select", "<textarea", "<a "])
    assert.equal(html.includes(tag), false, `inspection must not render ${tag}`);
});

test("loading / summary-only data is labelled as loading, never as configuration", () => {
  const summary = { ...inspectionFixture(), summaryOnly: true };
  const html = renderToStaticMarkup(React.createElement(AdminCardInspectionView, {
    state: inspectCard(summary), tournament: { kind: "loading" },
  }));
  assert.match(html, /data-inspection-state="partial"/);
  assert.match(html, /กำลังโหลดข้อมูลการ์ดฉบับเต็ม/);
  assert.equal(html.includes("Max Diff"), false);
});

test("the container reads only auth, cards and the GET tournament list from the store", () => {
  const component = source("src/ui/components/admin-card-inspection.tsx");
  const used = new Set([...component.matchAll(/useTournamentStore\(\(state\) => (?:selectCard\()?state\.(\w+)/g)].map((match) => match[1]));
  assert.equal((component.match(/useTournamentStore\(/g) ?? []).length, 3, "every store subscription is accounted for");
  assert.deepEqual([...used].sort(), ["auth", "cards", "loadTournaments"]);
  assert.equal(/method\s*:/.test(component), false, "no HTTP method override in the inspection component");
  assert.equal(/(?<![.\w])(fetch|request)\(/.test(component), false, "no direct HTTP calls (lookup.request is the GET-only controller)");
  const lookup = source("src/application/tournament/tournament-lookup.ts");
  assert.equal(/\bfetch\(|method\s*:|from "\.\/store"|from "@\/application\/tournament\/store"/.test(lookup), false,
    "the lookup only calls the injected loader (the store's GET loadTournaments)");
  // loadTournaments is a plain GET in the store.
  assert.match(source("src/application/tournament/store.ts"),
    /async loadTournaments\(\) \{\s*return request<Tournament\[\]>\("\/api\/tournaments"\);/);
});

test("inspection is mounted only on the authenticated /cards/[id] route, never on public routes", () => {
  assert.match(source("src/app/cards/[id]/page.tsx"), /<AdminCardInspection cardId=\{id\} \/>/);
  const publicFiles = [
    ...filesUnder("src/app/tour"), ...filesUnder("src/app/t"),
    "src/ui/components/card-overview.tsx", "src/ui/components/card-overview-view.tsx",
  ];
  for (const file of publicFiles)
    assert.equal(source(file).includes("admin-card-inspection"), false, `${file} must not import the inspection`);
});
