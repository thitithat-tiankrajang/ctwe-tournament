// Polling-only variant for a stock k6 binary (no SSE extension). Every viewer behaves like a
// browser whose EventSource was refused — the exact degraded mode the runtime settings produce.
import { suiteSetup, suiteOptions, viewerFlow, staffFlow } from "./lib.js";

export const options = suiteOptions();
export function setup() { return suiteSetup(); }
export function viewers(data) { viewerFlow(null, data); }
export function staff() { staffFlow(); }
