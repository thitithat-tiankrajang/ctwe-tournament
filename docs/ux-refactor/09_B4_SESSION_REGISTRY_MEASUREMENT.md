# B4 follow-up — does a logout free its `maximumSessions(2)` registry slot?

**Measured 2026-08-22, before any P1 code, per owner decision 3.**

```
ANSWER: NO. A logged-out session keeps occupying its registry slot.
STATUS: B4's last open item is now VERIFIED (negatively). Routed to P2 per 08_P1_PLAN.md §5.
IMPACT ON P1: none. The plan already anticipated this outcome. P1 proceeds unchanged.
```

This document is new evidence; it does not modify the frozen set (`01`–`06`). It **refines** R12
rather than contradicting it — see §4.

---

## 1. Method

A real servlet container was mandatory. `HttpSessionEventPublisher` is a **servlet listener**, so
under MockMvc no session lifecycle event fires at all and the measurement would return a false "no"
regardless of the wiring. The harness therefore used `@SpringBootTest(webEnvironment = RANDOM_PORT)`
with a real HTTP client and one cookie jar per simulated browser.

No real credential was used. The test created a throwaway `ROLE_ADMIN` account
(`p1-session-probe`) with a password generated per run, and deleted it afterwards.

### The discriminator

Browser **A** logs in, is probed once, and is then left **idle** — the idleness is what made R12
conclusive, and the same trick is required here.

| Arm | Sequence | If logout frees the slot | If it does not |
|---|---|---|---|
| **Control** | A idle · B login · C login | — | registry `{A,B,C}` = 3 → LRU evicted → **A dies** |
| **Measurement** | A idle · B login · **B logout** · C login | registry `{A,C}` = 2 → **A lives** | registry `{A, stale-B, C}` = 3 → **A dies** |

The control exists because the first attempt produced a **false result**: the probe checked only the
HTTP status, and an evicted session returns **200** (see §4). Both arms said "A survived", so the
experiment had no discriminating power. The probe was hardened to inspect the response **body**, and
the control then behaved as R12 predicted, proving the harness can discriminate.

## 2. Raw evidence

```
--- MEASUREMENT: A idle, B logs in then OUT, C logs in ---
  [A idle] POST /login                     -> 204   jsessionid=07DF06D5…
  [A idle] GET /api/admin/tournaments      -> 200  alive=true   body="[{"id":"476d110b-…","name":"P0 BASELINE (ux-re…"
  [B     ] POST /login                     -> 204   jsessionid=EB8EA493…
  [B     ] POST /logout                    -> 204
  [C     ] POST /login                     -> 204   jsessionid=5A7AA544…
  [A idle] GET /api/admin/tournaments      -> 200  alive=false  body="This session has been expired (possibly due to multiple concurrent login…"
  [A idle] GET /api/admin/tournaments      -> 401  alive=false  body=(empty)

  A EVICTED -> logout does NOT free its slot.
  Registry held {A, stale-B, C} = 3; the cap evicted least-recently-used.

--- CONTROL: A idle, then B and C log in (no logout anywhere) ---
  [A idle] POST /login                     -> 204   jsessionid=0B102D7B…
  [A idle] GET /api/admin/tournaments      -> 200  alive=true   body="[{"id":"476d110b-…"
  [B     ] POST /login                     -> 204   jsessionid=C68C6EB6…
  [C     ] POST /login                     -> 204   jsessionid=9D7466EB…
  [A idle] GET /api/admin/tournaments      -> 200  alive=false  body="This session has been expired…"
  => CONTROL: A evicted — consistent with R12. Harness discriminates.
```

```
Tests run: 2, Failures: 0, Errors: 0, Skipped: 0
[cleanup] probe account rows remaining: 0
```

**A was evicted in both arms.** B's logout did not release its slot.

## 3. Why — the mechanism, VERIFIED from source

| Fact | Evidence |
|---|---|
| `SessionRegistryImpl` removes an entry **only** on an application event | `javap` on `spring-security-core-6.4.2.jar`: `class SessionRegistryImpl implements SessionRegistry, ApplicationListener<AbstractSessionEvent>`; the removal method is `removeSessionInformation(String)`, driven by `onApplicationEvent` |
| Those events only exist if a servlet listener publishes them | `HttpSessionEventPublisher` is that listener |
| The application registers no such listener | grep over `backend/src/` for `HttpSessionEventPublisher`, `SessionRegistry`, `SessionRegistryImpl`, `maxSessionsPreventsLogin` → **zero hits** |
| Nothing else would auto-register one | `pom.xml` has `spring-boot-starter-security` only; **no Spring Session dependency** (which would bring its own registry wiring) |
| Logout invalidates the HTTP session but does not touch the registry | Spring Security's `SecurityContextLogoutHandler` clears the context and invalidates the session; no registry call |

So a logged-out session leaves a **stale `SessionInformation`** behind. It is not marked expired, so
`ConcurrentSessionControlAuthenticationStrategy` still counts it against the cap of 2.

**Consequence: the effective cap degrades with every logout.** Under D6/D9 (shared venue machines,
individual accounts, repeated logins across an event day) a user who logs in and out repeatedly
accumulates phantom entries, and eventually a fresh login evicts a genuinely active session.

## 4. Refinement of R12 — not a contradiction

R12 (frozen, `06_P0_RUNTIME_BASELINE.md`) records an evicted session receiving **401** from
`GET /api/admin/tournaments`. This run shows **200** with a plain-text body. Both are correct; they
are consecutive states:

| Request after eviction | Status | Body | Why |
|---|---|---|---|
| **1st** | **200** | `This session has been expired (possibly due to multiple concurrent logins…)` | `ConcurrentSessionFilter` logs the session out *on this request* and its default `SessionInformationExpiredStrategy` writes the message |
| **2nd** | **401** | empty | the session no longer exists, so the request is anonymous and hits `HttpStatusEntryPoint(UNAUTHORIZED)` for `/api/**` |

R12 observed the second state. **R12 stands.** This adds the first one.

### The part that matters for P2 — recorded, not fixed

That first response is **`200` with a non-JSON body**. In `store.ts`, `request()` treats any `2xx` as
success (`if (!response.ok)` is false), reaches
`const body = await response.text(); return body ? JSON.parse(body) as T : …`, and **`JSON.parse`
throws a `SyntaxError`** on `"This session has been expired…"`.

So the first request after an eviction surfaces as a **parse error, not a session-expiry redirect**.
The three defences named in B4 still catch it immediately afterwards (the SSE stream dies →
`ensureSessionAlive()`; `use-session-guard.ts` re-checks), so the observable window is one request —
which is why B4's LOW severity is unchanged.

**This is a P2 item. It is recorded here and deliberately not fixed** — P1 is backend-only and makes
no session changes.

## 5. What this does and does not change

| | |
|---|---|
| **P1** | **Unchanged.** `08_P1_PLAN.md` §5 already routes this outcome to P2: *"the fix is an additive three-line `HttpSessionEventPublisher` bean — but registering it is a P2 decision, not a P1 one, because it changes session behaviour."* |
| **P2** | Gains two concrete inputs: (a) decide on `HttpSessionEventPublisher`; (b) handle the `200 + non-JSON` eviction response, which currently produces a JSON parse error |
| **B4** | Last open item now closed, negatively. All of B4 is measured |

## 6. Reproducing

The harness is **not committed** — it is a measurement, not part of the approved P1 file set. It is
preserved at:

```
/private/tmp/claude-501/-Users-thitithat-tiankrajang-Desktop-CTWE/c10b2ddc-fec2-40a8-8411-160f5ce599c0/scratchpad/SessionRegistryLogoutDatabaseTest.java
```

To re-run, drop it into `backend/src/test/java/com/ctwe/tournament/infrastructure/security/` and:

```
cd backend && set -a && . ../.env && set +a && \
  mvn --batch-mode -o test -Dtest=SessionRegistryLogoutDatabaseTest
```

It is gated on `@EnabledIfEnvironmentVariable(named = "DATABASE_PASSWORD")`, so it is inert in CI.
It writes one clearly-marked throwaway account and deletes it; the `staff_accounts` table was
verified restored to its original 4 rows afterwards.
