import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { viewport as tourViewport } from "./tour/layout";

const APP = join(process.cwd(), "src/app");

/** Every route file under src/app, so a new `viewport` export anywhere cannot arrive unnoticed. */
function routeFiles(dir: string = APP): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return /\.(tsx?|jsx?)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

const declaringViewport = routeFiles()
  .filter((path) => /export\s+const\s+viewport\b/.test(readFileSync(path, "utf8")))
  .map((path) => relative(APP, path).split(sep).join("/"))
  .sort();

const TOUR_LAYOUT = readFileSync(join(APP, "tour/layout.tsx"), "utf8");
const ROOT_LAYOUT = readFileSync(join(APP, "layout.tsx"), "utf8");
/** The file's CODE. Its comments name the fields they forbid, so a raw grep would hit the prose. */
const TOUR_CODE = TOUR_LAYOUT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("the responsive viewer lays out at device width without zooming out", () => {
  assert.equal(tourViewport.initialScale, 1);
  assert.equal(tourViewport.width, "device-width");
  // The root layout sets it for the notch; a segment that re-declares `viewport` must keep it.
  assert.equal(tourViewport.viewportFit, "cover");
});

test("the viewer never takes pinch-to-zoom away from a spectator", () => {
  assert.equal(tourViewport.maximumScale, undefined, "maximumScale pins the page — leave it out");
  assert.equal(tourViewport.userScalable, undefined, "userScalable pins the page — leave it out");
  assert.doesNotMatch(TOUR_CODE, /maximumScale|userScalable|user-scalable|maximum-scale/i);
});

test("only the public tour and root layouts declare a viewport", () => {
  assert.deepEqual(
    declaringViewport,
    ["layout.tsx", "tour/layout.tsx"],
    "other routes should inherit the root viewport",
  );
  assert.equal(declaringViewport.includes("t/[token]/layout.tsx"), false);
});

test("the root viewport still renders every other route at 1:1", () => {
  const root = ROOT_LAYOUT.match(/export const viewport: Viewport = \{([^}]*)\}/);
  assert.ok(root, "the root viewport export is missing from src/app/layout.tsx");
  assert.match(root![1], /initialScale:\s*1\b/);
  assert.match(root![1], /width:\s*"device-width"/);
});

test("at every supported phone width the report stays a list, not the nine-column grid", () => {
  const view = readFileSync(join(process.cwd(), "src/ui/components/card-overview-view.tsx"), "utf8");
  const px = (name: string) => {
    const found = view.match(new RegExp(`${name}\\s*=\\s*"\\(max-width:\\s*(\\d+)px\\)"`));
    assert.ok(found, `${name} is no longer a (max-width: Npx) constant`);
    return Number(found![1]);
  };
  const scale = tourViewport.initialScale as number;
  const SUPPORTED_PHONE_PX = 480;
  const layoutWidth = Math.ceil(SUPPORTED_PHONE_PX / scale);

  assert.ok(
    layoutWidth <= px("PHONE_VIEWPORT"),
    `a ${SUPPORTED_PHONE_PX}px phone lays out at ${layoutWidth}px, past the ${px("PHONE_VIEWPORT")}px list breakpoint: it would get the nine-column grid`,
  );
  assert.ok(
    layoutWidth <= px("NARROW_VIEWPORT"),
    `a ${SUPPORTED_PHONE_PX}px phone lays out at ${layoutWidth}px, past the ${px("NARROW_VIEWPORT")}px breakpoint: it would lose the bottom navigation`,
  );
});
