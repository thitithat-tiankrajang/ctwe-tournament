/**
 * A stub stack that exercises the Phase H harness end to end without any real infrastructure.
 *
 * ⚠️  **This measures the harness, not the system.** Three local HTTP servers stand in for the
 * Worker, the Cloudflare/R2 snapshot host, and Render. They have no edge, no database, no JVM and no
 * network distance, so the latencies they produce are meaningless as capacity or cutover evidence.
 * What this proves is narrower and still worth proving: that the orchestrator ramps a mixed fleet,
 * that the published viewers really do resolve snapshots and really do leave Render alone, that the
 * ledger counts origin traffic when it happens, and that the runbook renders all four measurements
 * with honest statuses. Architecture §2.5's questions can only be answered by a staging deployment
 * behind the real CDN.
 *
 * It runs three passes so the report has something to compare:
 *
 *   1. baseline  — FLEET=live with no snapshot origin: the request sequence as it was before Phase H
 *   2. published — FLEET=published: the zero-Render path on its own
 *   3. mixed     — FLEET=mixed against the baseline: 2 live + 2 published tournaments
 *
 * Usage: `npx tsx scripts/simulate-stack.ts [outputDir]`
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { snapshotKey } from "../lib/snapshot-key.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE_TOKENS = ["sim-live-a", "sim-live-b"];
const PUBLISHED_TOKENS = ["sim-pub-a", "sim-pub-b"];
const CARD_IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];

interface Stub { origin: string; hits: number; close(): void }

function listen(handler: http.RequestListener): Promise<Stub> {
  const stub = { hits: 0 } as { hits: number };
  const server = http.createServer((req, res) => {
    stub.hits += 1;
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        get hits() { return stub.hits; },
        close: () => { server.closeAllConnections(); server.close(); },
      });
    });
  });
}

function snapshotEnvelope(token: string) {
  return JSON.stringify({
    snapshot: { schema: 1, version: 2, checksum: "sha256-simulated", generatedAt: new Date().toISOString() },
    payload: {
      id: `00000000-0000-4000-8000-${token.slice(-12).padStart(12, "0")}`,
      name: `Simulated ${token}`,
      cardCount: CARD_IDS.length,
      publishedCardCount: CARD_IDS.length,
      cards: CARD_IDS.map((id) => ({ id, version: 2, name: "Card", division: "OPEN", matches: [] })),
    },
  });
}

async function main(): Promise<void> {
  const outputRoot = path.resolve(process.argv[2] ?? path.join(HERE, "..", "results", "simulated"));
  fs.mkdirSync(outputRoot, { recursive: true });

  const frontend = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>simulated shell</title>");
  });

  const publishedKeys = new Set(PUBLISHED_TOKENS.map(snapshotKey));
  const cdn = await listen((req, res) => {
    const key = (req.url ?? "").replace(/^\/s\//, "").replace(/\.json$/, "");
    if (!publishedKeys.has(key)) {
      // The edge answers the negative lookup, exactly as mitigation M1/M2 intend it to.
      res.writeHead(404, { "cf-cache-status": "HIT", "cache-control": "public, max-age=60" });
      res.end("not found");
      return;
    }
    const token = PUBLISHED_TOKENS.find((candidate) => snapshotKey(candidate) === key)!;
    res.writeHead(200, { "content-type": "application/json", "cf-cache-status": "HIT" });
    res.end(snapshotEnvelope(token));
  });

  const origin = await listen((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/api/public/realtime-config")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ realtimeEnabled: true, sseEnabled: true, pollingEnabled: false, pollingIntervalMs: 60_000, reconnectDelayMs: 2_000 }));
      return;
    }
    if (url.includes("/bundle")) {
      const token = decodeURIComponent(url.split("/tournaments/")[1]?.split("/")[0] ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: `10000000-0000-4000-8000-${token.slice(-12).padStart(12, "0")}`,
        name: `Live ${token}`,
        accessToken: token,
        cards: CARD_IDS.map((id) => ({ id, name: "Card", division: "OPEN" })),
      }));
      return;
    }
    if (url.includes("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 5_000);
      res.on("close", () => clearInterval(heartbeat));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const common = {
    ...process.env,
    PUBLIC_API_ORIGIN: origin.origin,
    BACKEND_ORIGIN: origin.origin,
    TOURNAMENT_URL: `${frontend.origin}/tour/${LIVE_TOKENS[0]}`,
    LIVE_TOKENS: LIVE_TOKENS.join(","),
    FETCH_PAGE_DOCUMENT: "true",
    STAGES: "8,16",
    RAMP_SECONDS: "2",
    SETTLE_SECONDS: "1",
    HOLD_SECONDS: "4",
    SAMPLE_SECONDS: "2",
    STOP_ON_FAIL: "false",
  };

  const runPass = (name: string, env: Record<string, string>) => new Promise<void>((resolve, reject) => {
    const resultsDir = path.join(outputRoot, name);
    fs.mkdirSync(resultsDir, { recursive: true });
    console.log(`\n=== simulated pass: ${name} ===`);
    const child = spawn(
      process.execPath,
      [path.join(HERE, "..", "..", "node_modules", "tsx", "dist", "cli.mjs"), path.join(HERE, "orchestrator.ts")],
      {
        stdio: "inherit",
        env: { ...common, ...env, RESULTS_DIR: resultsDir, REPORTS_DIR: path.join(outputRoot, "reports") },
      },
    );
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)));
  });

  const latest = (name: string) => {
    const dir = path.join(outputRoot, name);
    const entry = fs.readdirSync(dir).filter((child) => fs.existsSync(path.join(dir, child, "run.json"))).sort().at(-1);
    if (!entry) throw new Error(`no run recorded for ${name}`);
    return path.join(dir, entry);
  };

  try {
    await runPass("baseline", { FLEET: "live" });
    const baselineDir = latest("baseline");

    await runPass("published", {
      FLEET: "published",
      SNAPSHOT_ORIGIN: cdn.origin,
      PUBLISHED_TOKENS: PUBLISHED_TOKENS.join(","),
    });

    await runPass("mixed", {
      FLEET: "mixed",
      SNAPSHOT_ORIGIN: cdn.origin,
      PUBLISHED_TOKENS: PUBLISHED_TOKENS.join(","),
      PUBLISHED_VIEWER_SHARE: "0.5",
      BASELINE_RUN_DIR: baselineDir,
    });

    console.log(`\nStub hit counts — frontend ${frontend.hits}, CDN ${cdn.hits}, Render ${origin.hits}`);
    console.log(`Reports: ${path.join(outputRoot, "reports")}`);
    console.log("\nReminder: these numbers describe three local Node servers. They are NOT capacity,");
    console.log("latency, or edge-caching evidence for the real deployment.");
  } finally {
    frontend.close();
    cdn.close();
    origin.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
