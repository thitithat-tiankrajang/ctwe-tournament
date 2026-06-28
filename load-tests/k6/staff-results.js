import http from "k6/http";
import { check, fail, sleep } from "k6";

const staff = (__ENV.STAFF_USERS || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const separator = entry.indexOf(":");
    return { username: entry.slice(0, separator), password: entry.slice(separator + 1) };
  });

export const options = {
  scenarios: {
    concurrent_result_entry: {
      executor: "per-vu-iterations",
      vus: Number(__ENV.STAFF_COUNT || 10),
      iterations: Number(__ENV.SAVES_PER_STAFF || 10),
      maxDuration: "5m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.001"],
    checks: ["rate>0.999"],
    "http_req_duration{resource:result-save}": ["p(95)<1500", "p(99)<2500"],
  },
};

const baseUrl = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
let csrfToken = "";
let cardId = "";
let matches = [];

function login() {
  if (staff.length === 0) fail("Set STAFF_USERS=user1:password1,... for isolated staff sessions");
  const credential = staff[(__VU - 1) % staff.length];
  const auth = http.get(`${baseUrl}/api/auth/me`, { tags: { resource: "auth" } });
  check(auth, { "CSRF bootstrap succeeded": (response) => response.status === 200 });
  csrfToken = auth.json("csrfToken");
  const response = http.post(`${baseUrl}/login`, {
    username: credential.username,
    password: credential.password,
    _csrf: csrfToken,
  }, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    tags: { resource: "login" },
  });
  check(response, { "staff login succeeded": (item) => item.status === 204 });
}

function loadWork() {
  const response = http.get(`${baseUrl}/api/cards`, { tags: { resource: "staff-card-list" } });
  check(response, { "staff card list succeeded": (item) => item.status === 200 });
  const cards = response.json();
  const requested = __ENV.CARD_ID;
  const card = cards.find((item) => item.id === requested)
    || cards.find((item) => item.runtimeStage === "RESULT_COLLECTION");
  if (!card) fail("No card in RESULT_COLLECTION; set CARD_ID or prepare a staging card");
  cardId = card.id;
  const snapshot = card.snapshots.find((item) => !item.confirmedAt);
  matches = snapshot
    ? snapshot.pairings.filter((pairing) => pairing.playerOneId && pairing.playerTwoId)
    : [];
  if (matches.length < Number(__ENV.STAFF_COUNT || 10))
    fail("The active result block does not have enough matches for isolated staff writes");
}

export default function () {
  if (!csrfToken) {
    login();
    loadWork();
  }
  const index = ((__VU - 1) + (__ITER * Number(__ENV.STAFF_COUNT || 10))) % matches.length;
  const match = matches[index];
  const scoreOne = 100 + (__ITER % 7);
  const scoreTwo = 70 + ((__VU + __ITER) % 11);
  const response = http.put(
    `${baseUrl}/api/cards/${cardId}/matches/${match.id}/result`,
    JSON.stringify({ scoreOne, scoreTwo, editExisting: true }),
    {
      headers: {
        "Content-Type": "application/json",
        "X-XSRF-TOKEN": csrfToken,
      },
      tags: { resource: "result-save" },
    },
  );
  check(response, {
    "result save succeeded": (item) => item.status === 200,
    "delta contains at most three rows": (item) => {
      if (item.status !== 200) return false;
      const changed = item.json("changedPairings");
      return Array.isArray(changed) && changed.length >= 1 && changed.length <= 3;
    },
  });
  sleep(0.15 + Math.random() * 0.35);
}
