// Side-by-side screenshots of the prototype and the local React app for the same pages.
//
//   1. Headless Chrome (once):
//      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
//        --no-first-run --hide-scrollbars --user-data-dir=/tmp/ctwe-ui-chrome \
//        --remote-debugging-address=127.0.0.1 --remote-debugging-port=9444 about:blank &
//   2. node scripts/ui/compare-shots.mjs <outdir> [name-filter] [d|m]
//
// Writes <outdir>/<page>-<d|m>-proto.png and -react.png. Logs in with the local test accounts in
// ~/.ctwe-local/prototype-port-accounts.env (never printed). BASE overrides http://127.0.0.1:3319.
// Card ids below are the local test database's; edit PAGES when the fixture changes.
import { mkdirSync } from "node:fs";
import { login, open, sleep } from "./cdp.mjs";

const [, , out = "/tmp/ctwe-ui-shots", only = "", devices = "dm"] = process.argv;
mkdirSync(out, { recursive: true });
const PROTO = "http://127.0.0.1:4317/";
const BASE = process.env.BASE || "http://127.0.0.1:3319";
const AMP = "dc539442-4783-4788-b19f-5e36c559c17a", AMM = "e21d2148-8066-4898-8a98-c41694ecfe38", CW = "8e843e4c-98a6-49e5-9c4c-02a2e33e9caf";
// [name, role, prototype query, React path]
const PAGES = [
  ["viewer-home", "viewer", "?role=viewer", "/tour/ctwe-ui-local"],
  ["viewer-card", "viewer", "?role=viewer&div=amp", `/tour/ctwe-ui-local#card=${AMP}`],
  ["staff-cards", "staff", "?role=staff&page=cards&div=amp", "/cards"],
  ["staff-overview", "staff", "?role=staff&page=overview&div=amp", `/cards/${AMP}`],
  ["staff-games", "staff", "?role=staff&page=games&div=amp", `/cards/${AMP}/games`],
  ["director-cards", "director", "?role=director&page=cards&div=amm", "/cards"],
  ["director-console", "director", "?role=director&page=director&div=amm", "/director"],
  ["director-overview", "director", "?role=director&page=overview&div=amm", `/cards/${AMM}`],
  ["director-players", "director", "?role=director&page=players&div=amm", `/cards/${AMM}/players`],
  ["director-players-reg", "director", "?role=director&page=players&div=cwp", `/cards/${CW}/players`],
  ["director-tables", "director", "?role=director&page=tables&div=amm", `/cards/${AMM}/tables`],
  ["director-games", "director", "?role=director&page=games&div=amm", `/cards/${AMM}/games`],
  ["director-audit", "director", "?role=director&page=audit&div=amm", `/cards/${AMM}/audit`],
  ["admin-home", "admin", "?role=admin&page=home&div=amm", "/"],
  ["admin-admin", "admin", "?role=admin&page=admin&div=amm", "/admin"],
  ["admin-devtools", "admin", "?role=admin&page=devtools&div=amm", "/dev-tools"],
  ["admin-overview", "admin", "?role=admin&page=overview&div=amm", `/cards/${AMM}`],
  ["admin-audit", "admin", "?role=admin&page=audit&div=amm", `/cards/${AMM}/audit`],
].filter(([name]) => name.includes(only));
const SIZES = { d: [1440, 900, false], m: [390, 844, true] };

const settle = async (p) => {
  for (let i = 0; i < 30; i++) {
    if (!(await p.ev(`return /กำลังตรวจสอบสิทธิ์|กำลังโหลด/.test(document.body.innerText)`))) break;
    await sleep(500);
  }
  await sleep(500);
};

const proto = await open(9444, { context: true });
const sessions = new Map();
for (const device of devices) {
  const [w, h, mobile] = SIZES[device];
  await proto.size(w, h, mobile);
  for (const [name, role, query, path] of PAGES) {
    await proto.go(PROTO + query, 1200);
    await proto.ev(`const bar = document.querySelector(".pbar"); if (bar) bar.style.display = "none"; return 1`);
    await proto.shot(`${out}/${name}-${device}-proto.png`, true);
    if (!sessions.has(role)) {
      const page = await open(9444, { context: true });
      if (role !== "viewer") await login(page, role, BASE);
      sessions.set(role, page);
    }
    const react = sessions.get(role);
    await react.size(w, h, mobile);
    await react.go("about:blank", 100);
    await react.go(BASE + path, 2500);
    await settle(react);
    await react.shot(`${out}/${name}-${device}-react.png`, true);
    console.log("shot", name, device);
  }
}
for (const page of [proto, ...sessions.values()]) page.close();
process.exit(0);
