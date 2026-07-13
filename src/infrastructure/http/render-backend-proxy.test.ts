import assert from "node:assert/strict";
import test from "node:test";

import { proxyToRender } from "./render-backend-proxy";

test("proxy failure returns a generic 503 without leaking backend details", async () => {
  const previousUrl = process.env.BACKEND_URL;
  const previousFetch = globalThis.fetch;
  const previousError = console.error;
  process.env.BACKEND_URL = "https://internal-backend.example";
  globalThis.fetch = async () => { throw new Error("secret upstream failure"); };
  console.error = () => undefined;

  try {
    const response = await proxyToRender(new Request("https://public.example/api/cards"));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { message: "Backend service is unavailable" });
  } finally {
    if (previousUrl === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = previousUrl;
    globalThis.fetch = previousFetch;
    console.error = previousError;
  }
});
