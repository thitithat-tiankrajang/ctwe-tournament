# REST API Contract

Base path: `/api`

## Authentication and authorization

- Public `GET` tournament data is read-only and does not require login.
- Every `POST`, `PUT`, and `DELETE` requires an authenticated `ROLE_STAFF` server session and a valid CSRF token.
- Staff login uses `POST /login` and returns `204` on success or `401` on invalid credentials; the frontend performs navigation without relying on a cross-origin redirect.
- Staff logout uses `POST /logout` and returns `204`; `GET /api/auth/me` returns membership, roles, and the CSRF request token.
- Mutations on an existing card require `If-Match: "<card.version>"`; stale versions return `409 Conflict`.
- Audit data and `/api/dev/**` are staff-only. Developer endpoints exist only when `DEV_TOOLS_ENABLED=true`.

## Cards

- `GET /cards` — list cards.
- `POST /cards` — create a card and all consecutive game/rule edges atomically.
- `GET /cards/{cardId}` — card summary and runtime state.
- `POST /cards/{cardId}/close` — close and lock a card.
- `GET /cards/{cardId}/export?format=csv|xlsx|json` — immutable export.

Create body:

```json
{
  "name": "A-Math Championship",
  "division": "Primary",
  "numberOfGames": 4,
  "rules": ["SWISS", "SWISS", "KING_OF_THE_HILL"]
}
```

## Players and seating

- `GET|POST /cards/{cardId}/players`
- `PUT|DELETE /cards/{cardId}/players/{playerId}`
- `POST /cards/{cardId}/registration/finish`
- `POST /cards/{cardId}/players/import` — multipart CSV.
- `GET /cards/{cardId}/players/export` — CSV.
- `POST /cards/{cardId}/pairings/preview`
- `POST /cards/{cardId}/tables/swap` with `{ "firstPlayerId": "...", "secondPlayerId": "...", "confirmSchoolConflict": true }`.

## Runtime

- `GET /cards/{cardId}/games/{gameNumber}/pairings`
- `PUT /cards/{cardId}/matches/{matchId}/result`
- `POST /cards/{cardId}/pairings/confirm` — locks the pairing and opens result collection.
- `POST /cards/{cardId}/results/review` — requires every current-game match to have a result.
- `POST /cards/{cardId}/results/reopen` — returns a review to result editing.
- `POST /cards/{cardId}/results/publish` — stores an append-only snapshot and exposes the game on public overview.
- `GET /cards/{cardId}/snapshots`

Mutating endpoints require `If-Match` with the current entity version. A stale version returns `409 Conflict`.

## Reporting and developer tools

- `GET /cards/{cardId}/standings`
- `GET /cards/{cardId}/audit`
- `POST /dev/cards/{cardId}/players?count=300|1000`
- `POST /dev/cards/{cardId}/results/auto`
- `POST /dev/cards/{cardId}/simulate`
- `POST /dev/cards/{cardId}/reset`

Every successful mutation emits one or more `audit_logs` rows in the same transaction.
