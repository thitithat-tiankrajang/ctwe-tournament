import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

test("portrait public reports use the page scroll instead of a nested 60vh scroller", () => {
  const bodyRule = CSS.match(/\.spectator-report__body\s*\{([^}]*)\}/);
  assert.ok(bodyRule, "the public report body rule is missing");
  assert.match(bodyRule![1], /max-height:\s*none/);
  assert.match(bodyRule![1], /overflow:\s*visible/);
  assert.match(bodyRule![1], /overscroll-behavior:\s*auto/);
  assert.doesNotMatch(bodyRule![1], /60vh|overflow-y:\s*auto/);
});

test("public reports keep one compact sticky context", () => {
  const reportHead = CSS.match(/\.spectator-report__head\s*\{([^}]*)\}/);
  assert.ok(reportHead, "the public report header rule is missing");
  assert.match(reportHead![1], /position:\s*sticky/);
  assert.match(reportHead![1], /top:\s*0/);

  const panelHeaderRules = CSS.matchAll(/\.spectator-shell \.overview-data-panel \.panel__header\s*\{([^}]*)\}/g);
  assert.equal(
    [...panelHeaderRules].some((match) => /position:\s*sticky/.test(match[1])),
    false,
    "the panel title must not become a second sticky report header",
  );
});
