# P0 — Baseline and Safe Prune

**STATUS: STATIC COMPLETE (+ test harness fixed) / RUNTIME IN PROGRESS**

Nothing here is committed. All changes are in the working tree.

---

## 1. Current state

| Item | Value |
|---|---|
| Baseline commit | `6ce756c9d77590f1e482d23b25ccea360db9c0a6` |
| Commit date | 2026-08-21 18:01:14 +0700 |
| Commit subject | `Merge branch 'staging': give metaspace the headroom the running app needs` |
| Branch | `main` |
| Working tree at P0 start | clean |
| Node used | **22.23.2** via `nvm use` (machine default is v26.6.0; `.nvmrc` pins 22) |

### Working tree after P0 (do NOT reset this)

```
 M package-lock.json
 M package.json
D  src/application/tournament/mock-data.ts
D  src/application/tournament/use-push-notifications.ts
D  src/domain/tournament/pairing.ts
D  src/lib/utils.ts
```

Rollback point if ever needed: `git checkout 6ce756c9d77590f1e482d23b25ccea360db9c0a6`.

---

## 2. Exact commands used

```bash
cd /Users/thitithat_tiankrajang/Desktop/CTWE
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use     # -> v22.23.2

git rev-parse HEAD
git status --porcelain

npm run lint
npm run typecheck
npm test
npm run build

# per-file test isolation check
npx tsx --test src/infrastructure/http/snapshot-api.test.ts
npx tsx --test src/infrastructure/http/system-state.test.ts
```

Prune commands:

```bash
git rm src/application/tournament/use-push-notifications.ts \
       src/application/tournament/mock-data.ts \
       src/domain/tournament/pairing.ts \
       src/lib/utils.ts
npm uninstall @tanstack/react-query-devtools class-variance-authority clsx tailwind-merge
```

`next-env.d.ts` is rewritten by `next build` (it flips the reference between `./.next-dev/types/routes.d.ts`
and `./.next/types/routes.d.ts` depending on which build ran last). It was reverted with
`git checkout -- next-env.d.ts`. **VERIFIED.** Consider gitignoring it later (not done in P0).

---

## 3. Baseline results — before and after prune

| Check | Before | After | Same? |
|---|---|---|---|
| `npm run lint` | exit 0 | exit 0 | yes |
| `npm run typecheck` | exit 0 | exit 0 | yes |
| `npm test` | exit 1 — 114 tests / 103 pass / **11 fail** | exit 1 — 114 / 103 / **11 fail** | yes, identical failing set (diffed) |
| `npm test` *(after the §4.3 harness fix)* | — | **exit 0 — 114 / 114 / 0 fail** | harness only; no product change |
| `npm run build` | exit 0 | exit 0 | yes |
| Bundle table (22 routes) | captured | captured | **`diff` = identical on every line** |

**Conclusion (VERIFIED): the prune changed no observable behaviour.**

### Bundle baseline (`npm run build`, Node 22.23.2)

```
Route (app)                                 Size  First Load JS
┌ ○ /                                    4.94 kB         118 kB
├ ○ /_not-found                             1 kB         103 kB
├ ○ /admin                               14.6 kB         123 kB
├ ƒ /api/[...path]                         143 B         103 kB
├ ○ /cards                               4.36 kB         117 kB
├ ƒ /cards/[id]                          2.21 kB         139 kB
├ ƒ /cards/[id]/audit                    1.99 kB         121 kB
├ ƒ /cards/[id]/games                    21.8 kB         147 kB
├ ƒ /cards/[id]/players                  11.5 kB         160 kB
├ ƒ /cards/[id]/standings                  143 B         103 kB
├ ƒ /cards/[id]/tables                   5.93 kB         130 kB
├ ○ /cards/create                        1.07 kB         143 kB
├ ○ /dev-tools                           4.59 kB         113 kB
├ ○ /director                            5.48 kB         147 kB
├ ƒ /login                                 143 B         103 kB
├ ƒ /logout                                143 B         103 kB
├ ○ /manifest.webmanifest                  143 B         103 kB
├ ○ /staff-login                         4.42 kB         113 kB
├ ○ /system                               3.4 kB         106 kB
├ ƒ /t/[token]                           2.73 kB         144 kB
├ ƒ /tour/[token]                        2.73 kB         144 kB
└ ○ /tournaments                           143 B         103 kB
+ First Load JS shared by all             102 kB
```

---

## 4. Pre-existing failing tests (11) — RESOLVED 2026-08-22 (test files only)

**They failed on a clean checkout of `6ce756c` before any change.** CI never runs `npm test`, so they
went unnoticed. Owner decision B: **fix the harness first**. Done — see §4.3.

### 4.1 The failing set (recorded for the record)

`src/infrastructure/http/snapshot-api.test.ts` — 2:

```
not ok 5  - with the origin unset, the probe never runs and no request is made
not ok 16 - a remembered 'live' answer skips the probe entirely on the next call
```

`src/infrastructure/http/system-state.test.ts` — 9:

```
not ok 5  - a 404 (the file was never written) fails toward available
not ok 6  - a 5xx from the CDN fails toward available
not ok 7  - a network failure fails toward available
not ok 8  - malformed JSON fails toward available
not ok 9  - a body that is not an object fails toward available
not ok 10 - a missing state field fails toward available
not ok 11 - an unknown state name fails toward available
not ok 12 - the answer is memoized, so a page with several readers makes one request
not ok 13 - a stray field cannot smuggle a value into the parsed state
```

(Aggregate `npm test` numbering: `not ok 83, 94, 100–108`.)

### 4.2 Root cause — TWO causes, not one. **VERIFIED by direct experiment.**

The earlier handoff attributed all 11 to one cause. Re-verification found two. Both are
test-harness problems; **no product code path is implicated.**

**Cause 1 — `?case=N` never isolated anything (9 + 1 failures).**

`package.json` has **no `"type": "module"`**, so tsx compiles these files to **CommonJS**, where a
query string does not key the require cache. Probe run inside the repo:

```
case=1 capturedAtLoad -> first
case=2 capturedAtLoad -> first     <-- expected "second"
b.peek() after a.bump()x2 -> 2     <-- 0 would mean isolated; 2 means SHARED
```

Consequences differ per file, and the earlier note was wrong about `system-state.ts`:

- `system-state.ts` does **NOT** read the env at module load. `origin()` (:30-32) resolves it
  **lazily** — the test file's own header comment claiming module-load binding was **stale**. The
  only state that leaked is the module-level `cached` memo (:39). The module already exports
  **`resetSystemStateCache()`** (:42) as the seam for exactly this; the tests never called it. That
  is why cases 1–4 passed (case 3 resets it inline) and 5–13 failed.
- `snapshot-api.ts` **does** bind at module load — `const configured = process.env…` (:31),
  `export const SNAPSHOT_ORIGIN = configured` (:37). Its case 5 needs a *different* origin, which is
  impossible in a shared process.

**Cause 2 — `sessionStorage` does not exist in Node (1 failure: snapshot-api case 16).**

Nothing to do with the module cache. `typeof sessionStorage === "undefined"` under Node 22 without
`--experimental-webstorage` (verified). `readMemo`/`writeMemo` (`snapshot-api.ts:156-177`) swallow
the resulting ReferenceError **by design** (private browsing, disabled storage, quota). So the memo
silently did nothing and the assertion failed `2 !== 1` because no memo was ever written.

> **Also found: a false pass.** Case 17, "a remembered 'published' answer still returns the
> snapshot", asserted `assert.ok()` on both calls — true whether or not the memo worked. It only
> began exercising the memo once a real `sessionStorage` existed.

**Product behaviour is correct and unchanged.** SSR has no `sessionStorage` either; the try/catch is
the intended fail-open guard.

### 4.3 The fix — test files only, zero product change

| File | Change |
|---|---|
| `system-state.test.ts` | `loadModule()` now sets the env and calls the existing `resetSystemStateCache()` seam against a single static import. No module-registry games |
| `snapshot-api.test.ts` | Module loaded **once** with the fixture origin (memoized promise); added an in-memory `sessionStorage` stub so the memo cases test real behaviour |
| `snapshot-api-origin-unset.test.ts` | **New.** The origin-unset case, extracted — the node test runner gives each file its own process, which is the only way to bind a different origin. Proven: it reads `SNAPSHOT_ORIGIN === ""` while its sibling binds the fixture origin in the same run |

Typecheck caught a latent trap during this work: the old **template-literal** import was
unresolvable to TS and so escaped `TS5097`; a static `"./snapshot-api.ts"` does not. Extension
dropped. `npm run typecheck` is exit 0.

### 4.4 Result

```
before: 114 tests / 103 pass / 11 fail / exit 1
after:  114 tests / 114 pass /  0 fail / exit 0
```

Test count is **unchanged at 114** — one case moved between files, none added or lost.
lint 0 · typecheck 0 · test 0 · build 0 · **bundle table byte-identical** (`diff` clean, 22 routes).

**The gate for P1–P7 is now "npm test is green", not "no new failures".**

## 5. Files deleted in P0

All four had **zero importers at file and symbol level**, re-verified immediately before deletion.

| File | Lines | Verification |
|---|---|---|
| `src/application/tournament/use-push-notifications.ts` | 215 | no importer; symbols `usePushNotifications`, `pushSupport`, `PushNotificationScope` referenced 0× elsewhere |
| `src/application/tournament/mock-data.ts` | 144 | no importer |
| `src/domain/tournament/pairing.ts` | 90 | no importer |
| `src/lib/utils.ts` | 36 | no importer; symbols `cn`, `playerSearchText`, `pairingSearchText`, `formatDateTime`, `downloadText` referenced 0× elsewhere |

Total: **485 lines deleted.**

`src/lib/clipboard.ts` was **kept** (imported by `src/app/admin/page.tsx`).

The only remaining textual mention of `use-push-notifications` is a historical note in
`docs/PUBLIC_SNAPSHOT_IMPLEMENTATION_PLAN.md:211` listing it as "NOT modified" — not an import.

## 6. Dependencies removed in P0

| Package | Import sites in `src/` |
|---|---|
| `@tanstack/react-query-devtools` | 0 |
| `class-variance-authority` | 0 |
| `clsx` | 0 (only `src/lib/utils.ts`, now deleted) |
| `tailwind-merge` | 0 (only `src/lib/utils.ts`, now deleted) |

`@tanstack/react-query` was **kept** — still referenced by `src/infrastructure/query/provider.tsx`.

Note: this project has **no Tailwind config**; `tailwind-merge` was dead weight.

---

## 7. Runtime baseline — NOT captured

Toolchain is available (**VERIFIED**): Docker running, Java 17.0.12, Maven 3.9.9, Postgres listening
on `localhost:5432`, `.env` contains all six required values.

Work stopped before writing to the local database because `generateMockPlayers` is documented as
replacing the current roster (`src/application/tournament/store.ts:101`,
`/api/dev/cards/{id}/players`), and the contents of the local DB are unknown.

Still required — see `05_HANDOFF.md` §5:

- HAR captures for 5 flows (login ×4 roles, card list, card overview, result entry, viewer)
- DB query counts per endpoint
- Isolated test tournament + 400-player dataset, dumped for reuse across phases
- SSE event traces ×3 (result save, pairing confirm, results publish)
- Published snapshot JSON + checksum
- Screenshots, 14 routes × 3 breakpoints
- `maximumSessions(2)` behaviour with 3+ sequential/concurrent logins
