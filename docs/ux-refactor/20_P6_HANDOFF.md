# P6 — HANDOFF. Not started. Scope investigated, nothing implemented.

```
HEAD:      1310aa6831e4b960b88f1bd7b697972e45165ed6
TREE:      clean
FROZEN:    EVIDENCE.sha256 → 7/7 OK
P6 SOURCE: NO changes started — the only commits since P4 are the two P5 ones
```

This document is a **handoff, not a plan**. No P6 implementation plan exists and the authoritative
docs do not require one. Nothing here has been built.

---

## 1. Current state

| | |
|---|---|
| P0 | CLOSED (`07_P0_CLOSURE.md`) |
| P1 | CLOSED (`10_P1_CLOSURE.md`) |
| P2 | CLOSED (`12_P2_CLOSURE.md`) |
| P3 | CLOSED (`15_P3_CLOSURE.md`) |
| P4 | CLOSED, final gate PASS (`18_P4_CLOSURE.md`) |
| P5 | **PARTIAL BY DECISION** (`19_P5_PARTIAL_CLOSURE.md`) — D21 shipped; D16 and "URL state" declined |
| P6 | **NOT STARTED** |

Gates at HEAD: `npm test` 178/178 · lint 0 · typecheck 0 · build 0 · backend 337 run / 0 fail / 0 skipped.

## 2. What P6 actually contains

`00_MASTER_PLAN.md` §3 defines P6 as *"Performance + accessibility remainder"*, split by the §4
scope freeze: **correctness half = SHOULD DO**, **performance half = CUT IF LATE**. There is no P6
chunk list anywhere. The scope has to be assembled from four sources, and this document does that.

> **Naming trap — read this before touching `design.md`.** Its item codes are
> **R = Remove, F = Fix, A = Add**. `UI-A5`, `UX-A1`, `UX-A2`, `UX-A4` are *Add* items, **not**
> accessibility items. Reading "A" as accessibility will produce a wrong P6 scope.

## 3. The 35 sub-11px font declarations — classified, not assumed

`00_MASTER_PLAN.md` §6 tracks *"Font sizes below 11px: 31 → 0"*. The count is now **35** in
`src/app/globals.css`. **They are not 35 bugs.** Classified by what each rule actually styles:

| Group | Count | Lines | Assessment |
|---|---|---|---|
| **Dead CSS — styles nothing** | **5** | 486, 489, 492, 496, 1056 | `.physical-table`, `.physical-match__label`, `.physical-player*`, `.pair-result-board` appear **only** in `globals.css`. Verified with a control (`card-folder__here`, `nav-link__flag`, `entry-keyin__label` all resolve to real components, these do not). **Not accessibility defects — dead rules.** Deleting them drops the metric 35 → 30 at zero user-visible risk |
| **Mobile-only overrides** | **4** | 1162, 1172 (≤768px), 1460, 1464 (≤720px) | `.mobile-nav .nav-link__text` 10px, `.overview-game-published` 10px, `.entry-keyin__label` 9px, `.entry-keyin__feedback` 10px. **Highest stakes**: the viewer is mobile-first (`design.md` §2.12) and result key-in happens on phones at a venue. **Strongest GO candidates** |
| **Content text — read for meaning** | **7** | 296, 300, 397, 525, 796, 1066, 1118 | Column headers (`.data-table th`), the school line under a player name (`.table-subline`, 9.5–10px), combobox option detail, filter option detail. Real reading, small type. **GO** |
| **Form labels** | **4** | 410, 632, 888, 892 | `.compact-field label`, `.entry-filter label`, `.director-game-picker__label`, `.overview-game-select label`. Labels should be legible. **GO, low risk** |
| **Badges / chips / dialog eyebrows** | **10** | 156, 170, 302, 500, 518, 543, 589, 598, 748, 802 | "ทำต่อ" flag, "ปัจจุบัน" badge, table badges, dialog eyebrow text. Uppercase micro-labels — **intentional metadata styling**, and enlarging them changes layout density across many screens. **CUT or defer to P7** (visual tokens), where the type scale is the actual subject |
| **Hints / counts** | **3** | 726, 770, 1064 | Filter count, filter hint, archive game number. Secondary. **Borderline — defer** |
| **Archive-only views** | **2** | 1061, 1069 | Read-only archived tournaments, lowest traffic. **CUT** |

**Recommended reading of the metric:** the honest target is **not** 0. Five are dead, and ~15 are
deliberate badge/eyebrow/metadata styling that belongs to P7's type scale. The defensible P6 scope is
the **15 in the first four groups** (5 dead + 4 mobile + 7 content − overlap, plus 4 labels), and the
success metric in `00_MASTER_PLAN.md` §6 should be **restated** rather than chased to literal zero.

> **Not verified:** none of these were checked in a browser at real device sizes, and no contrast or
> tap-target audit was run. The classification above is from source only. A next agent should confirm
> the mobile four on a real 375–390px viewport before changing them.

## 4. Other accessibility items (outside the font metric)

| Item | Source | Evidence | Recommendation |
|---|---|---|---|
| **`FreshSecretInput` screen-reader leak** | **D6**, decision register | Owner decision explicitly says the masking stays *"its screen-reader leak is still a defect to fix"*. A named, owner-acknowledged **defect** | **GO** — the strongest correctness-half candidate in P6 |
| **Sidebar renders two full menus** | `design.md`:135 | Rail + expanded rendered simultaneously, toggled by CSS; DOM duplication and layered `aria-hidden` | **CUT for now** — see risks §6 |

## 5. The performance half — what remains, and whether it has a baseline

| # | Item | Baseline | Overlap with P0–P5 | Recommendation |
|---|---|---|---|---|
| 1 | **`RUNTIME_SETTINGS_CACHE_TTL_SECONDS` (5s) equals `HEARTBEAT_TICK_MS` (5s)**, and `settings.get()` sits inside the guard, so it reads even with zero subscribers | **MEASURED** (`04_BLOCKERS.md`): 3 statements every 5s in a request-free window ≈ **17,280 transactions/day at idle**. Doc says *"Candidate for P6"* | none | **GO.** The only P6 performance item with a real measured baseline, and the doc says the cheapest fix is **config-only** — no code change, no risk to the frozen SSE layer |
| 2 | **Bulk player import: 800 individual INSERTs** | **MEASURED**: 285 ms locally; est. **0.8–4 s of held row lock** on Render. Registration-time only, before play | none | **DEFER.** Real but bounded, and it cannot affect live scoring. Owner call |
| 3 | Sidebar double menu render | none | touches P3-E's render path | **CUT** — see §6 |
| 4 | `/admin` ≤ 8 requests | measured (10–11), unmet since P3 | P3 established the cause | **NOT P6-ACTIONABLE** — needs a backend batch endpoint or **D3 admin narrowing**, an owner decision |

**The request-count and render work is already done.** P3 took `/admin` 15 → 10 and refocus 7 → 1 / 4 → 1;
P3-E took shell renders per SSE result event 1 → 0; P4 fixed SSE delivery correctness. What is left in
the performance half is **backend/config**, not frontend request counts — which is why the §4 freeze
put it under CUT IF LATE and why item 1 (a config value) is the only one clearly worth taking.

## 6. Risks — read before touching anything

- **`app-shell.tsx` is the highest-risk file in the repo.** P3-E restructured it to reach **zero shell
  renders per SSE result event**, and it hosts `CardSyncHost`. The sidebar double-menu item (§4, §5.3)
  lands squarely on it. Any change there must re-verify the P3-E metric, not assume it.
- **SSE:** `use-card-sync.ts` and `use-public-sync.ts` are frozen. `use-card-sync.ts` already carries
  **one owner-approved exception** (P4 actor forwarding); do not treat that as a general licence.
  `applyResultPatch` carries the P4 contiguity guard — the version-gap resync depends on it.
- **Request counts:** any change near the consoles must preserve **refocus = 1 request**. The
  `QueryClient` default `refetchOnWindowFocus: false` (P3-D2) is what holds that line; a `useQuery`
  added without understanding it re-opens the storm.
- **Responsive behaviour:** four of the font rules live inside `@media (max-width: 768px)` and
  `(max-width: 720px)`. Changing type size there affects the mobile viewer and the venue key-in screen.
  **A CDP viewport override does not fire `matchMedia` "change"**, and a headless pane reports
  `innerWidth: 0` until explicitly resized — set real dimensions before trusting any responsive reading.
- **`docs/ux-refactor/02_ARCHITECTURE_DECISIONS.md` is FROZEN EVIDENCE.** Do not edit it to record
  D-series status; the checksum will fail. Status goes in closure docs and the living master plan.
- **`npm test` enumerates test DIRECTORIES** in `package.json`. A test in a new directory silently
  never runs until its glob is added. **CI does not run `npm test` at all.**
- **No staging environment**, and the competition window is **~3 weeks from 2026-08-22**.

## 7. Recommendation summary

| Item | Call |
|---|---|
| `RUNTIME_SETTINGS_CACHE_TTL_SECONDS` above the 5s tick | **GO** — measured, config-only, zero code risk |
| `FreshSecretInput` screen-reader leak (D6) | **GO** — owner-acknowledged defect |
| Delete the 5 dead sub-11px rules | **GO** — zero risk, metric 35 → 30 |
| Raise the 4 mobile-only sizes | **GO after a real-device check** |
| Raise the 7 content + 4 label sizes | **GO, low risk** |
| Badges / eyebrows / hints / archive (≈15) | **CUT / defer to P7** — intentional metadata styling; restate the §6 metric instead of chasing 0 |
| Bulk import `jdbc.batchUpdate` | **DEFER** — measured but registration-time only; owner call |
| Sidebar double menu | **CUT** — touches P3-E's render path, no baseline |
| `/admin` ≤ 8 requests | **NOT P6** — needs backend batch or D3 (owner decision) |

## 8. Still open, unchanged

B7/SECURITY-01 · D17 · P1-D · D3 admin narrowing · `HttpSessionEventPublisher` · D16 and "URL state"
(declined in P5) · P7 visual tokens (CUT IF LATE, not started).
