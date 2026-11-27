// Minimal Chrome DevTools Protocol helper for UI checks (headless Chrome on port 9444).
// Node 22+ (global WebSocket). Used by scripts/ui/compare-shots.mjs.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function open(port = 9444, { context } = {}) {
  let browserContextId;
  if (context) {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const bws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((r) => bws.addEventListener("open", r, { once: true }));
    const res = await new Promise((r) => { bws.addEventListener("message", (m) => r(JSON.parse(m.data)), { once: true }); bws.send(JSON.stringify({ id: 1, method: "Target.createBrowserContext", params: { disposeOnDetach: false } })); });
    browserContextId = res.result.browserContextId;
    const t = await new Promise((r) => { bws.addEventListener("message", (m) => r(JSON.parse(m.data)), { once: true }); bws.send(JSON.stringify({ id: 2, method: "Target.createTarget", params: { url: "about:blank", browserContextId } })); });
    bws.close();
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = list.find((x) => x.id === t.result.targetId);
    return attach(target, port);
  }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  return attach(target, port);
}

async function attach(target, port) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0; const wait = new Map(); const errors = [];
  ws.addEventListener("message", (m) => {
    const x = JSON.parse(m.data);
    if (x.id && wait.has(x.id)) { wait.get(x.id)(x); wait.delete(x.id); }
    if (x.method === "Runtime.exceptionThrown") errors.push(x.params.exceptionDetails?.exception?.description || x.params.exceptionDetails?.text);
    if (x.method === "Runtime.consoleAPICalled" && x.params.type === "error") errors.push("console: " + x.params.args.map((a) => a.value ?? a.description).join(" "));
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; wait.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable"); await send("Runtime.enable");
  const api = {
    errors, send,
    async ev(expr) { const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; },
    async size(w, h, mobile = false) { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile }); if (mobile) await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }); else await send("Emulation.setTouchEmulationEnabled", { enabled: false }); },
    async go(url, wait = 1500) { await send("Page.navigate", { url }); await sleep(wait); },
    async shot(path, full = false) {
      await api.ev(`document.getAnimations().forEach(a => { try { if (a.effect?.getComputedTiming?.().iterations !== Infinity) a.finish(); } catch {} }); return 1;`);
      let clip;
      if (full) { const m = await send("Page.getLayoutMetrics"); const c = m.result.cssContentSize; clip = { x: 0, y: 0, width: Math.ceil(c.width), height: Math.min(Math.ceil(c.height), 6000), scale: 1 }; }
      const r = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}) });
      writeFileSync(path, Buffer.from(r.result.data, "base64"));
    },
    mouse: (x, y, type = "mouseMoved") => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 }),
    async click(x, y) { await api.mouse(x, y, "mousePressed"); await api.mouse(x, y, "mouseReleased"); },
    async key(key, code = key, keyCode) { await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode }); await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode }); },
    async type(text) { await send("Input.insertText", { text }); },
    close() { ws.close(); fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {}); },
  };
  return api;
}

/** Log into the local real app with a role from ~/.ctwe-local (values never printed). */
export async function login(p, role, base = "http://127.0.0.1:3319") {
  // The dev server may still be compiling the login page; confirm the session and retry once.
  for (let attempt = 0; attempt < 3; attempt++) {
    const at = await loginOnce(p, role, base);
    const ok = await p.ev(`const r = await fetch('/api/auth/me', { cache: 'no-store' }); return (await r.json()).authenticated === true`).catch(() => false);
    if (ok) return at;
    await sleep(2000);
  }
  throw new Error(`login as ${role} did not establish a session`);
}

async function loginOnce(p, role, base) {
  const env = Object.fromEntries(readFileSync(`${process.env.HOME}/.ctwe-local/prototype-port-accounts.env`, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")]; }));
  const user = `ctwe-local-${role}`; const secret = env[`CTWE_LOCAL_${role.toUpperCase()}_PASSWORD`];
  await p.go(`${base}/staff-login`, 2500);
  for (let i = 0; i < 60; i++) { const ok = await p.ev(`return !!document.querySelector('#login-account') && !document.querySelector('form button[type=submit]').disabled`); if (ok) break; await sleep(300); }
  await p.ev(`const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(document.querySelector('#login-account'), ${JSON.stringify(user)}); set(document.querySelector('#login-secret'), ${JSON.stringify(secret)}); await new Promise(r => setTimeout(r, 200)); document.querySelector('form button[type=submit]').click(); return 1;`);
  for (let i = 0; i < 40; i++) { await sleep(500); const at = await p.ev(`return location.pathname`); if (at !== "/staff-login") return at; }
  return p.ev(`return location.pathname`);
}
