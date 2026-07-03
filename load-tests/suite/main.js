// Full suite: SSE + polling fallback. Requires a k6 binary built with the SSE extension:
//   xk6 build --with github.com/phymbert/xk6-sse
// The runner (run-suite.sh) auto-detects the capability and picks this file or main-polling.js.
import sse from "k6/x/sse";
import { suiteSetup, suiteOptions, viewerFlow, staffFlow } from "./lib.js";

export const options = suiteOptions();
export function setup() { return suiteSetup(); }
export function viewers(data) { viewerFlow(sse, data); }
export function staff() { staffFlow(); }
