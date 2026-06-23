# Tournament Management System — Implementation Plan

## 1. Product slice

Build a PostgreSQL-backed tournament system with a server-enforced workflow. Zustand is a client cache only; Spring Boot transactions and the database are the source of truth.

## 2. Frontend architecture

- Next.js App Router and TypeScript.
- Feature-oriented folders: `domain`, `application`, `infrastructure`, and `ui`.
- Zustand hydrates and mutates state through the secured REST API; no tournament data is persisted in browser storage.
- Public navigation exposes only the card menu and published overview. Staff navigation exposes workflow and audit pages.
- React Hook Form and Zod validate card/player/result mutations.
- Shared square-corner UI primitives provide buttons, fields, badges, dialogs, tables, and empty states.
- Routes: cards, card creation, card overview, real-time players, pairing tables, results, compact audit, and developer tools. The former standings URL redirects to the real-time player table.

## 3. Domain rules

- A card generates consecutive games and one required rule per edge.
- Pairing rules are represented by pluggable strategy names: pair-result, Swiss, and king-of-the-hill.
- Seating groups players in fours while reducing same-school collisions.
- Runtime stages enforce player registration, pairing preview, result collection, review, publish, and final announcement.
- Game 1 seats can be swapped with school-conflict checks; later pairings are system-owned.
- Only reviewed and published results are copied into immutable snapshots and exposed publicly.
- Card closure locks runtime/player mutation and enables export surfaces.
- Every state mutation appends an audit record.

## 4. Visual system

- Flat, formal light UI with zero-radius controls and no decorative shadows/gradients.
- Blue = primary/navigation/focus, green = completed/positive, yellow = warning/pending, red = destructive/error.
- CSS Grid-first responsive layout; the side navigation becomes a compact horizontal navigation on smaller screens.
- Tables gain mobile card layouts where column compression would harm readability.
- No animations; pressed, focus, disabled, hover, empty, error, and loading states remain explicit.

## 5. Backend boundary

- Spring Boot modules follow domain/application/infrastructure/web boundaries.
- JPA entities cover cards, games, players, tables, matches, results, standings, rules, snapshots, and audit logs.
- Pairing algorithms implement a common interface and are resolved by type.
- PostgreSQL migration creates the normalized schema and immutable snapshot storage.
- REST contracts expose the frontend workflow while keeping pairing generation transactional.

## 6. Verification

- Type-check and production-build the frontend.
- Run lint where configured.
- Verify required routes, navigation, primary mutations, and viewport behavior in a real browser at desktop and mobile widths.
- Compile/test the backend when Maven is available.
