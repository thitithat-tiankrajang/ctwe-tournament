import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const viewers = Number(__ENV.VIEWERS || 5000);
const mode = __ENV.MODE || "sustained";
const hold = __ENV.HOLD || "10m";

const cacheHits = new Rate("vercel_cache_hits");
const responseBytes = new Trend("public_response_bytes", true);

const thresholds = {
  http_req_failed: ["rate<0.001"],
  checks: ["rate>0.999"],
  "http_req_duration{resource:catalog}": ["p(95)<750", "p(99)<1500"],
  "http_req_duration{resource:card}": ["p(95)<1000", "p(99)<2000"],
};

export const options = mode === "burst"
  ? {
      scenarios: {
        five_thousand_open_at_once: {
          executor: "shared-iterations",
          vus: viewers,
          iterations: viewers,
          maxDuration: "5m",
        },
      },
      thresholds,
    }
  : {
      scenarios: {
        sustained_viewers: {
          executor: "ramping-vus",
          startVUs: 0,
          stages: [
            { duration: "2m", target: viewers },
            { duration: hold, target: viewers },
            { duration: "1m", target: 0 },
          ],
          gracefulRampDown: "30s",
        },
      },
      thresholds,
    };

const baseUrl = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
let selectedCardId = "";
let selectedVersion = -1;

export default function () {
  if (selectedCardId) {
    const versions = http.get(`${baseUrl}/api/public/cards/versions`, {
      tags: { resource: "versions" },
      headers: { Accept: "application/json" },
    });
    responseBytes.add(versions.body ? versions.body.length : 0, { resource: "versions" });
    cacheHits.add(["HIT", "STALE"].includes(versions.headers["X-Vercel-Cache"]));
    check(versions, { "versions are 200": (response) => response.status === 200 });
    if (versions.status === 200) {
      const current = versions.json().find((item) => item.id === selectedCardId);
      if (current && current.version !== selectedVersion) {
        selectedVersion = current.version;
        loadCard();
      }
    }
    sleep(50 + Math.random() * 20);
    return;
  }

  const catalog = http.get(`${baseUrl}/api/public/cards`, {
    tags: { resource: "catalog" },
    headers: { Accept: "application/json" },
  });
  responseBytes.add(catalog.body ? catalog.body.length : 0, { resource: "catalog" });
  cacheHits.add(["HIT", "STALE"].includes(catalog.headers["X-Vercel-Cache"]));
  const catalogOk = check(catalog, {
    "catalog is 200": (response) => response.status === 200,
    "catalog is JSON": (response) => String(response.headers["Content-Type"]).includes("application/json"),
  });
  if (!catalogOk) return;

  const cards = catalog.json();
  if (!Array.isArray(cards) || cards.length === 0) return;
  const card = cards[(__VU - 1) % Math.min(cards.length, 3)];
  selectedCardId = card.id;
  selectedVersion = card.version;
  loadCard();

  if (mode !== "burst") sleep(50 + Math.random() * 20);
}

function loadCard() {
  const detail = http.get(`${baseUrl}/api/public/cards/${selectedCardId}?v=${selectedVersion}`, {
    tags: { resource: "card" },
    headers: { Accept: "application/json" },
  });
  responseBytes.add(detail.body ? detail.body.length : 0, { resource: "card" });
  cacheHits.add(["HIT", "STALE"].includes(detail.headers["X-Vercel-Cache"]));
  check(detail, {
    "card is 200": (response) => response.status === 200,
    "card id is correct": (response) => response.status === 200 && response.json("id") === selectedCardId,
    "card has an ETag": (response) => Boolean(response.headers.ETag || response.headers.Etag),
  });
}
