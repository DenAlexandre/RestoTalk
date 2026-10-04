# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

RestoTalk is a restaurant table-communication app: a diner scans the QR code on their table to join a session under a pseudo, then can message or call other occupied tables, with the recipient able to accept or refuse. The product is built phase by phase; the build order and full product design live in `docs/superpowers/specs/2026-10-04-restotalk-design.md` (§14). Phase-specific specs/plans are added as phases are built — check `docs/superpowers/specs/` and `docs/superpowers/plans/` for the current state before starting new work; don't re-derive decisions already recorded there.

Only the backend (`backend/`) exists so far — a NestJS + PostgreSQL (Prisma) API with a Socket.io realtime layer. The React Native mobile app and later phases (voice calls, web back-office, push notifications) are not yet implemented.

## Commands

All commands run from `backend/`.

Setup:
```bash
docker compose up -d          # starts Postgres (also serves as the test DB — see Known gotchas)
npm install
npx prisma migrate dev        # apply/create migrations against schema.prisma
```

Run:
```bash
npm run start:dev             # watch mode, http://localhost:3000
```

Build and lint:
```bash
npm run build
npm run lint
npm run format
```

Tests — there are two separate Jest configs:
```bash
npm test                                          # unit/integration specs, *.spec.ts under src/ (rootDir: src)
npm run test:e2e                                  # full-stack e2e specs under test/ (separate jest-e2e.json config)
npx jest path/to/file.spec.ts                      # single unit spec
npx jest path/to/file.spec.ts -t "test name"       # single test case
npx jest --config ./test/jest-e2e.json some.e2e-spec.ts   # single e2e spec
npx jest --runInBand                              # run serially — see Known gotchas before running the full suite
```

Unit/integration specs hit a real Postgres instance via `PrismaService` (no mocking) — Postgres must be running. Migrations are tracked in `backend/prisma/migrations/`; add new ones with `npx prisma migrate dev --name <description>`.

## Architecture

### Module graph and why `MessagingModule` is a separate top-level module

`SessionsModule` imports `TablesModule` (session creation needs to look up tables). This means `TablesModule` can never import `SessionsModule` back — anything that needs both (e.g. a controller exposing table data that also requires session auth) lives in its own module instead. `MessagingModule` was introduced for exactly this reason: it imports both `TablesModule` and `SessionsModule` and hosts `TablesDirectoryController` (`GET /tables/occupied`) alongside the messaging controllers, rather than adding a controller directly to `TablesModule`. Follow this pattern — don't add a `SessionAuthGuard`-protected controller into `TablesModule` itself.

A module that provides `@UseGuards(SessionAuthGuard)` to be used by controllers in *other* modules must export not just `SessionAuthGuard` but also `JwtModule` (from `SessionsModule`'s own imports) — NestJS does not transitively re-export a module's own imports just because a provider depending on them is exported. `SessionsModule` already does this (`exports: [SessionsService, SessionAuthGuard, JwtModule]`); keep it that way if you touch that file.

### Session/auth model

A `ClientSession` is created fresh on every QR scan (`POST /sessions`) — there are no persistent user accounts. The QR payload is `{ tableId, secret }`; `secret` is compared against `Table.qrTokenSecret` with `crypto.timingSafeEqual` (length-checked first to avoid the length-mismatch throw), not a signed JWT — only the resulting *session* token handed back to the client is a real JWT (`SessionTokenPayload { sub, tableId }`, 6h expiry, `process.env.JWT_SECRET`).

`SessionAuthGuard` and `RealtimeGateway`'s Socket.io auth middleware both verify the JWT *and* independently re-query the session's DB `status` — a cryptographically valid, unexpired JWT is rejected if the session has been marked `expired`/`left`/`kicked_by_staff` in the database. Session status in the DB is the source of truth, not JWT validity. A scheduled job (`SessionExpirationService`, `@Cron(EVERY_MINUTE)`) expires sessions idle past `sessionInactivityTimeoutHours` (from `config/restaurant.yaml`) and flips the table back to `free` via `TablesService.refreshStatus`, which recomputes occupancy from the live count of `active` sessions — never flip `Table.status` by hand elsewhere.

### Realtime (Socket.io) conventions

- Internal `EventEmitter2` event names are dot-separated (`table.presence.changed`, `contact.request`, `contact.resolved`, `message.new`); the corresponding Socket.io wire events sent to clients are colon-separated (`tables:update`, `contact:request`, `contact:resolved`, `message:new`). Keep this split when adding new realtime events.
- Socket.io authentication runs as a `server.use()` middleware in `RealtimeGateway.afterInit`, **not** inside `handleConnection` — by the time `handleConnection` fires the handshake has already completed, so rejecting there surfaces as a client-side `'disconnect'` instead of `'connect_error'`. Do the same JWT + DB active-session check pattern as `SessionAuthGuard` if you add new gateway behavior.
- Authenticated sockets join a `table:${tableId}` room. `tables:update` (global presence) is broadcast to everyone via `server.emit`; everything table-specific (`contact:request`, `contact:resolved`, `message:new`) is scoped with `server.to(`table:${tableId}`).emit(...)`. Use the room-scoped form for anything that shouldn't be visible to unrelated tables.

### Messaging domain rules

Authorization between two tables (`TableContact`) is one-time **per unordered pair**, not per direction: `MessagingService.findLiveContact` checks both `{tableAId,tableBId}` orderings and matches `status: { in: ['pending','accepted'] }` — `refused` contacts are excluded, so the next message between that pair creates a brand-new contact. No message content is ever exposed (via REST or socket) before the owning contact is `accepted`.

### Configuration

`config/restaurant.yaml` (name, `tableCount`, `sessionInactivityTimeoutHours`) is loaded once at boot via `RestaurantConfigService` (validated with `zod`) and drives `TableSeedService.ensureTablesSeeded`, which creates missing `Table` rows up to `tableCount` on every `onApplicationBootstrap` — it never deletes existing tables, even if `tableCount` shrinks.

### Known gotchas

- Prisma is deliberately pinned at **5.20.0** (both `prisma` and `@prisma/client`) — a later major removed the `url = env(...)` datasource syntax this schema relies on. Don't bump it casually.
- `TEST_DATABASE_URL` in `.env` is currently unused — `PrismaService` only reads `DATABASE_URL`, so tests run against the same database as `npm run start:dev`, not an isolated test DB. Cleanup hooks (`afterEach`/`afterAll`) are what keep this safe; don't skip them when adding tests.
- `TableSeedService.ensureTablesSeeded`'s read-then-`createMany` is not atomic and can race when multiple e2e spec files each bootstrap a full `AppModule` concurrently under parallel Jest workers, producing intermittent unique-constraint failures. Run `npx jest --runInBand` if you see spurious seeding-related failures on a full-suite run.
- An accepted `TableContact` currently survives a table's free→occupied turnover (new occupants inherit a prior group's accepted contact and message history) — a known, deliberately deferred product-policy gap, not an oversight to silently "fix" without raising it.
