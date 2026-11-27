---
name: ui-change
description: Port UI/UX changes from the CTWE prototype (~/Desktop/CTWE-prototype) into the React app using the prototype's git checkpoints. Use when the user asks to change or tweak the UI, says they edited the prototype, asks to sync/port the prototype to React, or asks what differs between prototype and React. Not for sync/SSE/cache/auth/API/backend work — change React directly for those.
---

# UI change via prototype checkpoints

The prototype is the UI/UX source of truth; React matched it at the commit recorded in
`docs/ui-workflow/prototype-synced`. Never re-compare whole pages — work only from the diff since
that sync point. Full guide (Thai, with the prototype → React file map): `docs/ui-workflow/README.md`.

1. **Change the prototype first** when the request is about look, layout, wording, motion or
   interaction order: edit `~/Desktop/CTWE-prototype/site/index.html` in place — the LAST
   definition of the function/CSS rule (later definitions override earlier ones). Check it at
   http://127.0.0.1:4317/?role=director (viewer|staff|admin); start it with
   `python3 -m http.server 4317 --bind 127.0.0.1` from `site/` if nothing listens there.
2. `scripts/ui/proto.sh checkpoint "<what changed>"` once the prototype change is right.
3. `scripts/ui/proto.sh summary` — changed functions/CSS rules since the sync point (cheap).
   Read hunks only for those regions with `scripts/ui/proto.sh diff /tmp/proto.diff` and targeted
   reads of that file; do not read index.html wholesale (~600 KB).
4. Port each changed region using the map in the README (CSS rule `.x` → `.ctwe-prototype .x` in
   `src/app/prototype-workspace.css`). Keep React-only behaviour (sync, drafts, permissions,
   server validation) intact; prototype fixtures/simulations are not ported.
5. Verify: `npx tsc --noEmit -p .`, `npm test`, and for visible changes
   `node scripts/ui/compare-shots.mjs /tmp/ctwe-ui-shots <page-filter>` (needs headless Chrome on
   9444; see the file header) and view the `-proto`/`-react` pairs. React runs on
   http://127.0.0.1:3319 (the only origin the local backend accepts) as a production build:
   rebuild with `scripts/ui/serve-local.sh prod` after code changes (`dev` mode is far slower).
6. When React fully matches: `scripts/ui/proto.sh synced`, and commit
   `docs/ui-workflow/prototype-synced` together with the React change. If something was left
   unported, do not mark synced; say what remains.

Gotchas: no module-level JSX in files tests import (tsx classic runtime → `React is not defined`);
`globals.test.ts` fails on CSS rules that no longer match any markup — delete rules you orphan.
