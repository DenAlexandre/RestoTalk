# RestoTalk Backend Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the NestJS/PostgreSQL backend foundation — config loading, data model, QR-based session creation, and real-time table presence over Socket.io — so a client can scan a table's QR code, pick a pseudo, and see the live list of occupied tables.

**Architecture:** A single NestJS application (`backend/`) backed by PostgreSQL via Prisma. Table seeding reads a YAML config at boot. Session creation validates a per-table opaque secret (not a signed JWT — see note below) and issues a short-lived app JWT used for all subsequent REST calls and the Socket.io handshake. Table occupancy and presence broadcast are driven by domain events (`@nestjs/event-emitter`) so the Socket.io gateway stays decoupled from session/table business logic.

**Note on QR tokens vs. the design spec:** The spec (section 4) describes the QR payload loosely as "a JWT signed by the backend." The data model (section 3) stores a `qr_token_secret` column per `Table`, which only makes sense if each table's QR encodes its *own* opaque secret, not a JWT signed with one shared backend key (a shared signing key would make "regenerate this table's QR without affecting others" impossible). This plan implements the schema-consistent version: the QR encodes `{ tableId, secret }`, the backend looks up `Table` by id and compares `secret` to the stored `qr_token_secret` using a constant-time comparison. Regenerating a table's QR simply replaces that row's `qr_token_secret`. The session token handed back to the app *is* a real signed JWT (short-lived, app-wide secret) — that part of the spec is unchanged.

**Tech Stack:** NestJS 10, Prisma + PostgreSQL, `@nestjs/jwt`, `@nestjs/schedule`, `@nestjs/event-emitter`, `@nestjs/websockets` + `socket.io`, `zod` (config validation), `js-yaml`, Jest + Supertest + `socket.io-client` for tests.

**Spec:** `docs/superpowers/specs/2026-10-04-restotalk-design.md` (sections 2, 3, 4, 8, 9)

## Global Constraints

- No persistent client accounts: a `ClientSession` is created fresh on every QR scan and is never linked across visits (spec §3, §4).
- `Table` rows are never deleted automatically when `tableCount` shrinks in config — only created when missing (spec §3, §8).
- QR secret comparison must be constant-time (`crypto.timingSafeEqual`) to avoid timing side-channels (spec §10).
- All timestamps are stored and compared in UTC.
- Session inactivity timeout and table count come from the YAML config file, never hardcoded (spec §8).
- Session JWT expiry is a fixed 6 hours (spec §4); the configurable `sessionInactivityTimeoutHours` is a separate, server-side, DB-driven expiry check — a valid, unexpired JWT for a session the inactivity job has marked `expired` must still be rejected (session status is authoritative, not JWT validity alone).

## Review Focus

- A `POST /sessions` request for a `tableId` that does not exist must return 404, not silently create an orphaned session.
- A `POST /sessions` request with a valid `tableId` but wrong `secret` must be rejected (401), including when `secret` has the right length but wrong content (ruling out a naive substring/prefix check).
- Re-running table seeding on a second boot (restart) must not change any existing table's `qr_token_secret` or reset active sessions — only tables missing from the DB get created.
- Two sessions joining the same table concurrently must both leave the table `occupied`, and the table must only flip back to `free` when the *last* active session at that table ends (not on every session end regardless of siblings).
- A session whose inactivity timeout has passed must be rejected by the auth guard on its very next request even though its JWT is still cryptographically valid and unexpired.

---

## File Structure

```
backend/
  src/
    app.module.ts
    main.ts
    config/
      config.module.ts
      restaurant-config.service.ts
      restaurant-config.schema.ts
    prisma/
      prisma.module.ts
      prisma.service.ts
    tables/
      tables.module.ts
      tables.service.ts
      table-seed.service.ts
    sessions/
      sessions.module.ts
      sessions.controller.ts
      sessions.service.ts
      session-auth.guard.ts
      session-expiration.service.ts
      dto/create-session.dto.ts
    realtime/
      realtime.module.ts
      realtime.gateway.ts
  prisma/
    schema.prisma
  config/
    restaurant.yaml
  docker-compose.yml
  .env.example
  package.json
  tsconfig.json
  nest-cli.json
test/ (Nest e2e convention, inside backend/test/)
  session-flow.e2e-spec.ts
```

---

### Task 1: Project scaffolding, Postgres, environment

**Files:**
- Create: `backend/` (via Nest CLI)
- Create: `backend/docker-compose.yml`
- Create: `backend/.env.example`
- Create: `backend/.env` (local only, not committed)

**Interfaces:**
- Produces: a running NestJS app (`npm run start:dev` serves on port from `PORT` env, default `3000`); a Postgres instance reachable at `DATABASE_URL` for dev, and a second database `restotalk_test` for tests.

- [ ] **Step 1: Scaffold the NestJS project**

Run from the repo root:

```bash
npx @nestjs/cli@10 new backend --skip-git --package-manager npm
```

- [ ] **Step 2: Add runtime and dev dependencies**

```bash
cd backend
npm install @nestjs/config @nestjs/schedule @nestjs/event-emitter @nestjs/websockets @nestjs/platform-socket.io @nestjs/jwt socket.io @prisma/client js-yaml zod
npm install -D prisma @types/js-yaml supertest @types/supertest socket.io-client
```

- [ ] **Step 3: Add Postgres via docker-compose**

Create `backend/docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: restotalk
      POSTGRES_PASSWORD: restotalk
      POSTGRES_DB: restotalk
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

- [ ] **Step 4: Add environment files**

Create `backend/.env.example`:

```
DATABASE_URL="postgresql://restotalk:restotalk@localhost:5432/restotalk?schema=public"
TEST_DATABASE_URL="postgresql://restotalk:restotalk@localhost:5432/restotalk_test?schema=public"
JWT_SECRET="dev-only-change-me"
PORT=3000
```

Copy it to `backend/.env` (same content — local dev only, this file must not be committed).

- [ ] **Step 5: Start Postgres and verify the app boots**

```bash
docker compose -f backend/docker-compose.yml up -d
cd backend && npm run start:dev
```

Expected: Nest logs `Nest application successfully started`, and `curl http://localhost:3000` returns the default "Hello World!" response. Stop the dev server after verifying.

- [ ] **Step 6: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/src backend/docker-compose.yml backend/.env.example backend/tsconfig.json backend/nest-cli.json backend/.gitignore
git commit -m "chore: scaffold NestJS backend with Postgres docker-compose"
```

---

### Task 2: Prisma schema and `PrismaService`

**Files:**
- Create: `backend/prisma/schema.prisma`
- Create: `backend/src/prisma/prisma.service.ts`
- Create: `backend/src/prisma/prisma.module.ts`
- Test: `backend/src/prisma/prisma.service.spec.ts`

**Interfaces:**
- Consumes: `DATABASE_URL` env var (Task 1).
- Produces: `PrismaService` (injectable, extends `PrismaClient`, implements `OnModuleInit`/`OnModuleDestroy` to connect/disconnect), exported by `PrismaModule`. Prisma models `Table { id, number, qrTokenSecret, status, createdAt }` and `ClientSession { id, tableId, pseudo, pushToken, joinedAt, lastSeenAt, leftAt, status }` with enums `TableStatus { free, occupied }` and `ClientSessionStatus { active, expired, left, kicked_by_staff }`.

- [ ] **Step 1: Write the Prisma schema**

Create `backend/prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum TableStatus {
  free
  occupied
}

enum ClientSessionStatus {
  active
  expired
  left
  kicked_by_staff
}

model Table {
  id            Int             @id @default(autoincrement())
  number        Int             @unique
  qrTokenSecret String          @unique @map("qr_token_secret")
  status        TableStatus     @default(free)
  createdAt     DateTime        @default(now()) @map("created_at")
  sessions      ClientSession[]

  @@map("tables")
}

model ClientSession {
  id         Int                  @id @default(autoincrement())
  tableId    Int                  @map("table_id")
  table      Table                @relation(fields: [tableId], references: [id])
  pseudo     String
  pushToken  String?              @map("push_token")
  joinedAt   DateTime             @default(now()) @map("joined_at")
  lastSeenAt DateTime             @default(now()) @map("last_seen_at")
  leftAt     DateTime?            @map("left_at")
  status     ClientSessionStatus  @default(active)

  @@map("client_sessions")
}
```

- [ ] **Step 2: Generate the client and run the first migration**

```bash
cd backend
npx prisma migrate dev --name init
```

Expected: a new `backend/prisma/migrations/<timestamp>_init/migration.sql` is created and applied to the `restotalk` database without errors.

- [ ] **Step 3: Write `PrismaService`**

Create `backend/src/prisma/prisma.service.ts`:

```typescript
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

Create `backend/src/prisma/prisma.module.ts`:

```typescript
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

- [ ] **Step 4: Write the failing test**

Create `backend/src/prisma/prisma.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('can create and read back a Table row', async () => {
    const table = await prisma.table.create({
      data: { number: 9999, qrTokenSecret: 'test-secret-9999' },
    });

    const found = await prisma.table.findUnique({ where: { id: table.id } });
    expect(found?.number).toBe(9999);
    expect(found?.status).toBe('free');

    await prisma.table.delete({ where: { id: table.id } });
  });
});
```

- [ ] **Step 5: Run the test to verify it fails first (no DB connection configured for tests yet is fine — the point here is to confirm the test file runs and fails for the right reason if the env is missing)**

Run: `cd backend && DATABASE_URL="postgresql://restotalk:restotalk@localhost:5432/restotalk?schema=public" npx jest prisma.service.spec.ts`
Expected at this point: PASS (the migration from Step 2 already created the schema) — if it fails, read the error: either Postgres isn't running (`docker compose up -d`) or the migration didn't apply.

- [ ] **Step 6: Commit**

```bash
git add backend/prisma backend/src/prisma
git commit -m "feat: add Prisma schema (Table, ClientSession) and PrismaService"
```

---

### Task 3: Restaurant config loading (YAML)

**Files:**
- Create: `backend/config/restaurant.yaml`
- Create: `backend/src/config/restaurant-config.schema.ts`
- Create: `backend/src/config/restaurant-config.service.ts`
- Create: `backend/src/config/config.module.ts`
- Test: `backend/src/config/restaurant-config.service.spec.ts`

**Interfaces:**
- Produces: `RestaurantConfig` type `{ name: string; tableCount: number; sessionInactivityTimeoutHours: number }`; `RestaurantConfigService.get(): RestaurantConfig`, injectable via `ConfigModule`, reads the file path from env var `RESTAURANT_CONFIG_PATH` (defaults to `config/restaurant.yaml` relative to `backend/`).

- [ ] **Step 1: Write the failing test**

Create `backend/src/config/restaurant-config.service.spec.ts`:

```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RestaurantConfigService } from './restaurant-config.service';

describe('RestaurantConfigService', () => {
  function writeTempConfig(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restotalk-config-'));
    const filePath = path.join(dir, 'restaurant.yaml');
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  it('loads a valid config file', () => {
    const filePath = writeTempConfig(`
restaurant:
  name: "Le Bistrot"
  tableCount: 20
  sessionInactivityTimeoutHours: 4
`);

    const service = new RestaurantConfigService(filePath);

    expect(service.get()).toEqual({
      name: 'Le Bistrot',
      tableCount: 20,
      sessionInactivityTimeoutHours: 4,
    });
  });

  it('throws a descriptive error when tableCount is missing', () => {
    const filePath = writeTempConfig(`
restaurant:
  name: "Le Bistrot"
  sessionInactivityTimeoutHours: 4
`);

    expect(() => new RestaurantConfigService(filePath)).toThrow(/tableCount/);
  });

  it('throws when the file does not exist', () => {
    expect(() => new RestaurantConfigService('/no/such/file.yaml')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest restaurant-config.service.spec.ts`
Expected: FAIL with "Cannot find module './restaurant-config.service'"

- [ ] **Step 3: Write the schema and service**

Create `backend/src/config/restaurant-config.schema.ts`:

```typescript
import { z } from 'zod';

export const restaurantConfigSchema = z.object({
  restaurant: z.object({
    name: z.string().min(1),
    tableCount: z.number().int().positive(),
    sessionInactivityTimeoutHours: z.number().positive(),
  }),
});

export type RestaurantConfig = z.infer<typeof restaurantConfigSchema>['restaurant'];
```

Create `backend/src/config/restaurant-config.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { restaurantConfigSchema, RestaurantConfig } from './restaurant-config.schema';

@Injectable()
export class RestaurantConfigService {
  private readonly config: RestaurantConfig;

  constructor(
    filePath: string = process.env.RESTAURANT_CONFIG_PATH ?? 'config/restaurant.yaml',
  ) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = yaml.load(raw);
    const result = restaurantConfigSchema.safeParse(parsed);

    if (!result.success) {
      throw new Error(
        `Invalid restaurant config at ${filePath}: ${result.error.message}`,
      );
    }

    this.config = result.data.restaurant;
  }

  get(): RestaurantConfig {
    return this.config;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest restaurant-config.service.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Create the real dev config file and the module**

Create `backend/config/restaurant.yaml`:

```yaml
restaurant:
  name: "Le Bistrot"
  tableCount: 20
  sessionInactivityTimeoutHours: 4
```

Create `backend/src/config/config.module.ts`:

```typescript
import { Global, Module } from '@nestjs/common';
import { RestaurantConfigService } from './restaurant-config.service';

@Global()
@Module({
  providers: [
    {
      provide: RestaurantConfigService,
      useFactory: () => new RestaurantConfigService(),
    },
  ],
  exports: [RestaurantConfigService],
})
export class ConfigModule {}
```

- [ ] **Step 6: Commit**

```bash
git add backend/config backend/src/config
git commit -m "feat: load and validate restaurant.yaml config"
```

---

### Task 4: Table seeding on boot

**Files:**
- Create: `backend/src/tables/tables.module.ts`
- Create: `backend/src/tables/tables.service.ts`
- Create: `backend/src/tables/table-seed.service.ts`
- Test: `backend/src/tables/table-seed.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (Task 2), `RestaurantConfigService.get()` (Task 3).
- Produces: `TablesService.findById(id: number): Promise<Table | null>`, `TablesService.ensureTablesSeeded(tableCount: number): Promise<void>`; `TableSeedService` implementing `OnApplicationBootstrap`, calling `ensureTablesSeeded` with the configured `tableCount`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/tables/table-seed.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { TablesService } from './tables.service';

describe('TablesService.ensureTablesSeeded', () => {
  let prisma: PrismaService;
  let service: TablesService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PrismaService, TablesService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(TablesService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    await prisma.table.deleteMany({ where: { number: { gte: 1, lte: 5 } } });
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('creates missing tables up to tableCount', async () => {
    await service.ensureTablesSeeded(3);

    const tables = await prisma.table.findMany({
      where: { number: { in: [1, 2, 3] } },
      orderBy: { number: 'asc' },
    });

    expect(tables.map((t) => t.number)).toEqual([1, 2, 3]);
    expect(tables.every((t) => t.qrTokenSecret.length > 0)).toBe(true);
  });

  it('does not change the secret of an already-seeded table on a second run', async () => {
    await service.ensureTablesSeeded(2);
    const before = await prisma.table.findUnique({ where: { number: 1 } });

    await service.ensureTablesSeeded(2);
    const after = await prisma.table.findUnique({ where: { number: 1 } });

    expect(after?.qrTokenSecret).toBe(before?.qrTokenSecret);
  });

  it('never deletes a table that already exists, even if tableCount shrinks', async () => {
    await service.ensureTablesSeeded(5);
    await service.ensureTablesSeeded(2);

    const stillThere = await prisma.table.findUnique({ where: { number: 5 } });
    expect(stillThere).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest table-seed.service.spec.ts`
Expected: FAIL with "Cannot find module './tables.service'"

- [ ] **Step 3: Write `TablesService`**

Create `backend/src/tables/tables.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { Table } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TablesService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: number): Promise<Table | null> {
    return this.prisma.table.findUnique({ where: { id } });
  }

  async ensureTablesSeeded(tableCount: number): Promise<void> {
    const existing = await this.prisma.table.findMany({
      where: { number: { lte: tableCount } },
      select: { number: true },
    });
    const existingNumbers = new Set(existing.map((t) => t.number));

    const missing = [];
    for (let number = 1; number <= tableCount; number++) {
      if (!existingNumbers.has(number)) {
        missing.push({
          number,
          qrTokenSecret: crypto.randomBytes(24).toString('hex'),
        });
      }
    }

    if (missing.length > 0) {
      await this.prisma.table.createMany({ data: missing });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest table-seed.service.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire the bootstrap seeding service and module**

Create `backend/src/tables/table-seed.service.ts`:

```typescript
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { RestaurantConfigService } from '../config/restaurant-config.service';
import { TablesService } from './tables.service';

@Injectable()
export class TableSeedService implements OnApplicationBootstrap {
  constructor(
    private readonly tablesService: TablesService,
    private readonly configService: RestaurantConfigService,
  ) {}

  async onApplicationBootstrap() {
    const { tableCount } = this.configService.get();
    await this.tablesService.ensureTablesSeeded(tableCount);
  }
}
```

Create `backend/src/tables/tables.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { TablesService } from './tables.service';
import { TableSeedService } from './table-seed.service';

@Module({
  providers: [TablesService, TableSeedService],
  exports: [TablesService],
})
export class TablesModule {}
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/tables
git commit -m "feat: seed tables from config on application bootstrap"
```

---

### Task 5: QR-based session creation (`POST /sessions`)

**Files:**
- Create: `backend/src/sessions/dto/create-session.dto.ts`
- Create: `backend/src/sessions/sessions.service.ts`
- Create: `backend/src/sessions/sessions.controller.ts`
- Create: `backend/src/sessions/sessions.module.ts`
- Test: `backend/src/sessions/sessions.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `TablesService.findById` (Task 4), `@nestjs/jwt`'s `JwtService`.
- Produces: `SessionsService.createSession(dto: CreateSessionDto): Promise<{ sessionToken: string; session: ClientSession }>` — throws `NotFoundException` for an unknown `tableId`, `UnauthorizedException` for a wrong `secret`. `CreateSessionDto = { tableId: number; secret: string; pseudo: string }`. Emits event `'table.presence.changed'` with payload `{ tableId: number }` via `EventEmitter2` after creating a session (consumed by Task 9).

- [ ] **Step 1: Write the failing test**

Create `backend/src/sessions/sessions.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { JwtModule } from '@nestjs/jwt';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from './sessions.service';

describe('SessionsService.createSession', () => {
  let prisma: PrismaService;
  let service: SessionsService;
  let tableId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        JwtModule.register({ secret: 'test-secret', signOptions: { expiresIn: '6h' } }),
      ],
      providers: [PrismaService, SessionsService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(SessionsService);
    await prisma.onModuleInit();

    const table = await prisma.table.create({
      data: { number: 9101, qrTokenSecret: 'correct-secret' },
    });
    tableId = table.id;
  });

  afterAll(async () => {
    await prisma.clientSession.deleteMany({ where: { tableId } });
    await prisma.table.delete({ where: { id: tableId } });
    await prisma.onModuleDestroy();
  });

  it('creates a session and returns a signed token for a valid secret', async () => {
    const result = await service.createSession({
      tableId,
      secret: 'correct-secret',
      pseudo: 'Alice',
    });

    expect(result.session.pseudo).toBe('Alice');
    expect(result.session.status).toBe('active');
    expect(typeof result.sessionToken).toBe('string');
    expect(result.sessionToken.split('.')).toHaveLength(3);
  });

  it('rejects an unknown tableId', async () => {
    await expect(
      service.createSession({ tableId: 999999, secret: 'anything', pseudo: 'Bob' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a wrong secret of the same length', async () => {
    await expect(
      service.createSession({ tableId, secret: 'wrong-secret-x', pseudo: 'Eve' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a wrong secret of a different length', async () => {
    await expect(
      service.createSession({ tableId, secret: 'short', pseudo: 'Mallory' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest sessions.service.spec.ts`
Expected: FAIL with "Cannot find module './sessions.service'"

- [ ] **Step 3: Write the DTO and service**

Create `backend/src/sessions/dto/create-session.dto.ts`:

```typescript
export class CreateSessionDto {
  tableId: number;
  secret: string;
  pseudo: string;
}
```

Create `backend/src/sessions/sessions.service.ts`:

```typescript
import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import { ClientSession } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TablesService } from '../tables/tables.service';
import { CreateSessionDto } from './dto/create-session.dto';

function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tablesService: TablesService,
    private readonly jwtService: JwtService,
    private readonly events: EventEmitter2,
  ) {}

  async createSession(
    dto: CreateSessionDto,
  ): Promise<{ sessionToken: string; session: ClientSession }> {
    const table = await this.tablesService.findById(dto.tableId);
    if (!table) {
      throw new NotFoundException('Unknown table');
    }

    if (!secretsMatch(dto.secret, table.qrTokenSecret)) {
      throw new UnauthorizedException('Invalid QR secret');
    }

    const session = await this.prisma.clientSession.create({
      data: { tableId: table.id, pseudo: dto.pseudo },
    });

    await this.prisma.table.update({
      where: { id: table.id },
      data: { status: 'occupied' },
    });

    const sessionToken = this.jwtService.sign({ sub: session.id, tableId: table.id });

    this.events.emit('table.presence.changed', { tableId: table.id });

    return { sessionToken, session };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest sessions.service.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the controller and module**

Create `backend/src/sessions/sessions.controller.ts`:

```typescript
import { Body, Controller, Post } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { CreateSessionDto } from './dto/create-session.dto';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Post()
  async create(@Body() dto: CreateSessionDto) {
    const { sessionToken, session } = await this.sessionsService.createSession(dto);
    return {
      sessionToken,
      session: { id: session.id, pseudo: session.pseudo, tableId: session.tableId },
    };
  }
}
```

Create `backend/src/sessions/sessions.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { TablesModule } from '../tables/tables.module';

@Module({
  imports: [
    TablesModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '6h' },
    }),
  ],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/sessions
git commit -m "feat: add POST /sessions QR-based session creation"
```

---

### Task 6: Session auth guard and `GET /sessions/me`

**Files:**
- Create: `backend/src/sessions/session-auth.guard.ts`
- Modify: `backend/src/sessions/sessions.service.ts` — add `touchLastSeen`
- Modify: `backend/src/sessions/sessions.controller.ts` — add `GET /sessions/me`
- Test: `backend/src/sessions/session-auth.guard.spec.ts`

**Interfaces:**
- Consumes: `JwtService` (Task 5), `PrismaService`.
- Produces: `SessionAuthGuard` (sets `request.session = ClientSession` on success, throws `UnauthorizedException` otherwise); `SessionsService.touchLastSeen(sessionId: number): Promise<ClientSession>`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/sessions/session-auth.guard.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionAuthGuard } from './session-auth.guard';

function contextWithAuthHeader(header?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: header } }),
    }),
  } as unknown as ExecutionContext;
}

describe('SessionAuthGuard', () => {
  let prisma: PrismaService;
  let jwtService: JwtService;
  let guard: SessionAuthGuard;
  let tableId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'test-secret' })],
      providers: [PrismaService, SessionAuthGuard],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    jwtService = moduleRef.get(JwtService);
    guard = moduleRef.get(SessionAuthGuard);
    await prisma.onModuleInit();

    const table = await prisma.table.create({
      data: { number: 9102, qrTokenSecret: 'secret-9102' },
    });
    tableId = table.id;
  });

  afterAll(async () => {
    await prisma.clientSession.deleteMany({ where: { tableId } });
    await prisma.table.delete({ where: { id: tableId } });
    await prisma.onModuleDestroy();
  });

  it('allows a valid token for an active session', async () => {
    const session = await prisma.clientSession.create({
      data: { tableId, pseudo: 'Alice', status: 'active' },
    });
    const token = jwtService.sign({ sub: session.id, tableId });

    const context = contextWithAuthHeader(`Bearer ${token}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rejects a well-formed token for a session marked expired in the DB', async () => {
    const session = await prisma.clientSession.create({
      data: { tableId, pseudo: 'Bob', status: 'expired' },
    });
    const token = jwtService.sign({ sub: session.id, tableId });

    const context = contextWithAuthHeader(`Bearer ${token}`);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a missing Authorization header', async () => {
    const context = contextWithAuthHeader(undefined);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a malformed token', async () => {
    const context = contextWithAuthHeader('Bearer not-a-real-token');
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest session-auth.guard.spec.ts`
Expected: FAIL with "Cannot find module './session-auth.guard'"

- [ ] **Step 3: Write the guard**

Create `backend/src/sessions/session-auth.guard.ts`:

```typescript
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';

export interface SessionTokenPayload {
  sub: number;
  tableId: number;
}

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = header.slice('Bearer '.length);

    let payload: SessionTokenPayload;
    try {
      payload = this.jwtService.verify<SessionTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    const session = await this.prisma.clientSession.findUnique({
      where: { id: payload.sub },
    });

    if (!session || session.status !== 'active') {
      throw new UnauthorizedException('Session is not active');
    }

    request.session = session;
    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest session-auth.guard.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Add `touchLastSeen` and `GET /sessions/me`**

Add to `backend/src/sessions/sessions.service.ts` (append method inside the class):

```typescript
  async touchLastSeen(sessionId: number) {
    return this.prisma.clientSession.update({
      where: { id: sessionId },
      data: { lastSeenAt: new Date() },
    });
  }
```

Modify `backend/src/sessions/sessions.controller.ts` to add the `GET /sessions/me` route:

```typescript
import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { SessionAuthGuard } from './session-auth.guard';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Post()
  async create(@Body() dto: CreateSessionDto) {
    const { sessionToken, session } = await this.sessionsService.createSession(dto);
    return {
      sessionToken,
      session: { id: session.id, pseudo: session.pseudo, tableId: session.tableId },
    };
  }

  @UseGuards(SessionAuthGuard)
  @Get('me')
  async me(@Req() req: any) {
    const updated = await this.sessionsService.touchLastSeen(req.session.id);
    return {
      id: updated.id,
      pseudo: updated.pseudo,
      tableId: updated.tableId,
      status: updated.status,
    };
  }
}
```

Register `SessionAuthGuard` as a provider in `backend/src/sessions/sessions.module.ts` (add `SessionAuthGuard` to the `providers` array).

- [ ] **Step 6: Commit**

```bash
git add backend/src/sessions
git commit -m "feat: add session auth guard and GET /sessions/me"
```

---

### Task 7: Session leave endpoint and table status refresh

**Files:**
- Modify: `backend/src/tables/tables.service.ts` — add `refreshStatus`
- Modify: `backend/src/sessions/sessions.service.ts` — add `leaveSession`
- Modify: `backend/src/sessions/sessions.controller.ts` — add `POST /sessions/:id/leave`
- Test: `backend/src/tables/tables.service.spec.ts`
- Test: `backend/src/sessions/sessions.service.spec.ts` (extend)

**Interfaces:**
- Consumes: `PrismaService`.
- Produces: `TablesService.refreshStatus(tableId: number): Promise<void>` (sets `Table.status` to `occupied` if any `ClientSession` with `status = 'active'` exists for that table, else `free`); `SessionsService.leaveSession(sessionId: number): Promise<void>` (sets session `status = 'left'`, `leftAt = now`, then calls `refreshStatus` and emits `'table.presence.changed'`).

- [ ] **Step 1: Write the failing test for `refreshStatus`**

Create `backend/src/tables/tables.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { TablesService } from './tables.service';

describe('TablesService.refreshStatus', () => {
  let prisma: PrismaService;
  let service: TablesService;
  let tableId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PrismaService, TablesService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(TablesService);
    await prisma.onModuleInit();
  });

  beforeEach(async () => {
    const table = await prisma.table.create({
      data: { number: 9201, qrTokenSecret: 'secret-9201', status: 'occupied' },
    });
    tableId = table.id;
  });

  afterEach(async () => {
    await prisma.clientSession.deleteMany({ where: { tableId } });
    await prisma.table.delete({ where: { id: tableId } });
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('flips to free when no active sessions remain', async () => {
    await prisma.clientSession.create({
      data: { tableId, pseudo: 'Alice', status: 'left' },
    });

    await service.refreshStatus(tableId);

    const table = await prisma.table.findUnique({ where: { id: tableId } });
    expect(table?.status).toBe('free');
  });

  it('stays occupied when at least one active session remains', async () => {
    await prisma.clientSession.create({
      data: { tableId, pseudo: 'Alice', status: 'left' },
    });
    await prisma.clientSession.create({
      data: { tableId, pseudo: 'Bob', status: 'active' },
    });

    await service.refreshStatus(tableId);

    const table = await prisma.table.findUnique({ where: { id: tableId } });
    expect(table?.status).toBe('occupied');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest tables.service.spec.ts`
Expected: FAIL with "service.refreshStatus is not a function"

- [ ] **Step 3: Implement `refreshStatus`**

Add to `backend/src/tables/tables.service.ts` (inside the class):

```typescript
  async refreshStatus(tableId: number): Promise<void> {
    const activeCount = await this.prisma.clientSession.count({
      where: { tableId, status: 'active' },
    });

    await this.prisma.table.update({
      where: { id: tableId },
      data: { status: activeCount > 0 ? 'occupied' : 'free' },
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest tables.service.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing test for `leaveSession`, then implement it**

Append to `backend/src/sessions/sessions.service.spec.ts` (new `describe` block in the same file):

```typescript
describe('SessionsService.leaveSession', () => {
  let prisma: PrismaService;
  let service: SessionsService;
  let tableId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        JwtModule.register({ secret: 'test-secret' }),
      ],
      providers: [PrismaService, SessionsService, TablesService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(SessionsService);
    const table = await prisma.table.create({
      data: { number: 9202, qrTokenSecret: 'secret-9202', status: 'occupied' },
    });
    tableId = table.id;
  });

  afterAll(async () => {
    await prisma.clientSession.deleteMany({ where: { tableId } });
    await prisma.table.delete({ where: { id: tableId } });
    await prisma.onModuleDestroy();
  });

  it('marks the session left and frees the table when it was the last active one', async () => {
    const session = await prisma.clientSession.create({
      data: { tableId, pseudo: 'Alice', status: 'active' },
    });

    await service.leaveSession(session.id);

    const updatedSession = await prisma.clientSession.findUnique({ where: { id: session.id } });
    const table = await prisma.table.findUnique({ where: { id: tableId } });
    expect(updatedSession?.status).toBe('left');
    expect(updatedSession?.leftAt).not.toBeNull();
    expect(table?.status).toBe('free');
  });
});
```

Add the required imports at the top of `backend/src/sessions/sessions.service.spec.ts`: `TablesService` from `'../tables/tables.service'`.

Add to `backend/src/sessions/sessions.service.ts` — inject `TablesService` in the constructor and add the method:

```typescript
  constructor(
    private readonly prisma: PrismaService,
    private readonly tablesService: TablesService,
    private readonly jwtService: JwtService,
    private readonly events: EventEmitter2,
  ) {}

  // ...existing createSession, touchLastSeen...

  async leaveSession(sessionId: number): Promise<void> {
    const session = await this.prisma.clientSession.update({
      where: { id: sessionId },
      data: { status: 'left', leftAt: new Date() },
    });

    await this.tablesService.refreshStatus(session.tableId);
    this.events.emit('table.presence.changed', { tableId: session.tableId });
  }
```

(`TablesService` is already injected in this class from Task 5 — `createSession` currently updates `table.status` directly; leave that line as-is, it is harmless and `refreshStatus` will correct it from Task 8 onward too.)

- [ ] **Step 6: Run the full sessions test file to verify it passes**

Run: `cd backend && npx jest sessions.service.spec.ts`
Expected: PASS (all tests, including the new `leaveSession` block)

- [ ] **Step 7: Wire the controller route**

Add to `backend/src/sessions/sessions.controller.ts`:

```typescript
  @UseGuards(SessionAuthGuard)
  @Post(':id/leave')
  async leave(@Req() req: any) {
    await this.sessionsService.leaveSession(req.session.id);
    return { status: 'left' };
  }
```

(The route ignores the `:id` URL param and uses `req.session.id` from the guard, so a client can only ever leave its own session — add `import { Param } from '@nestjs/common'` only if you choose to validate that the URL `:id` matches `req.session.id`; for this plan, trusting the guard-attached session is sufficient and simpler.)

- [ ] **Step 8: Commit**

```bash
git add backend/src/tables backend/src/sessions
git commit -m "feat: add session leave endpoint and table status refresh"
```

---

### Task 8: Session inactivity expiration cron job

**Files:**
- Create: `backend/src/sessions/session-expiration.service.ts`
- Modify: `backend/src/sessions/sessions.module.ts` — register `ScheduleModule` and the new service
- Modify: `backend/src/app.module.ts` — import `ScheduleModule.forRoot()`
- Test: `backend/src/sessions/session-expiration.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `RestaurantConfigService.get().sessionInactivityTimeoutHours`, `TablesService.refreshStatus` (Task 7).
- Produces: `SessionExpirationService.expireInactiveSessions(): Promise<number>` (returns the count of sessions it expired), scheduled via `@Cron(CronExpression.EVERY_MINUTE)`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/sessions/session-expiration.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { TablesService } from '../tables/tables.service';
import { SessionExpirationService } from './session-expiration.service';
import { RestaurantConfigService } from '../config/restaurant-config.service';

describe('SessionExpirationService.expireInactiveSessions', () => {
  let prisma: PrismaService;
  let service: SessionExpirationService;
  let tableId: number;

  beforeAll(async () => {
    const fakeConfig = { get: () => ({ sessionInactivityTimeoutHours: 4 }) };

    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        PrismaService,
        TablesService,
        SessionExpirationService,
        { provide: RestaurantConfigService, useValue: fakeConfig },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(SessionExpirationService);
    await prisma.onModuleInit();

    const table = await prisma.table.create({
      data: { number: 9301, qrTokenSecret: 'secret-9301', status: 'occupied' },
    });
    tableId = table.id;
  });

  afterAll(async () => {
    await prisma.clientSession.deleteMany({ where: { tableId } });
    await prisma.table.delete({ where: { id: tableId } });
    await prisma.onModuleDestroy();
  });

  it('expires sessions inactive past the configured timeout and frees the table', async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const staleSession = await prisma.clientSession.create({
      data: { tableId, pseudo: 'Alice', status: 'active' },
    });
    await prisma.clientSession.update({
      where: { id: staleSession.id },
      data: { lastSeenAt: fiveHoursAgo },
    });

    const expiredCount = await service.expireInactiveSessions();

    const updated = await prisma.clientSession.findUnique({ where: { id: staleSession.id } });
    const table = await prisma.table.findUnique({ where: { id: tableId } });
    expect(expiredCount).toBe(1);
    expect(updated?.status).toBe('expired');
    expect(table?.status).toBe('free');
  });

  it('leaves a recently active session untouched', async () => {
    const freshSession = await prisma.clientSession.create({
      data: { tableId, pseudo: 'Bob', status: 'active' },
    });

    await service.expireInactiveSessions();

    const unchanged = await prisma.clientSession.findUnique({ where: { id: freshSession.id } });
    expect(unchanged?.status).toBe('active');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest session-expiration.service.spec.ts`
Expected: FAIL with "Cannot find module './session-expiration.service'"

- [ ] **Step 3: Write the service**

Create `backend/src/sessions/session-expiration.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TablesService } from '../tables/tables.service';
import { RestaurantConfigService } from '../config/restaurant-config.service';

@Injectable()
export class SessionExpirationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tablesService: TablesService,
    private readonly configService: RestaurantConfigService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron() {
    await this.expireInactiveSessions();
  }

  async expireInactiveSessions(): Promise<number> {
    const { sessionInactivityTimeoutHours } = this.configService.get();
    const cutoff = new Date(Date.now() - sessionInactivityTimeoutHours * 60 * 60 * 1000);

    const stale = await this.prisma.clientSession.findMany({
      where: { status: 'active', lastSeenAt: { lt: cutoff } },
    });

    for (const session of stale) {
      await this.prisma.clientSession.update({
        where: { id: session.id },
        data: { status: 'expired' },
      });
      await this.tablesService.refreshStatus(session.tableId);
    }

    return stale.length;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest session-expiration.service.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Register the schedule module and the service**

Modify `backend/src/app.module.ts` to add `ScheduleModule.forRoot()` to the root `imports` array (alongside the existing `TablesModule`, `SessionsModule`, `ConfigModule`, `PrismaModule`):

```typescript
import { ScheduleModule } from '@nestjs/schedule';
// ...other imports...

@Module({
  imports: [
    ScheduleModule.forRoot(),
    // ...existing imports (ConfigModule, PrismaModule, TablesModule, SessionsModule, RealtimeModule)...
  ],
})
export class AppModule {}
```

Add `SessionExpirationService` to the `providers` array of `backend/src/sessions/sessions.module.ts`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/sessions backend/src/app.module.ts
git commit -m "feat: expire inactive sessions on a scheduled job"
```

---

### Task 9: Socket.io gateway and table presence broadcast

**Files:**
- Create: `backend/src/realtime/realtime.gateway.ts`
- Create: `backend/src/realtime/realtime.module.ts`
- Modify: `backend/src/tables/tables.service.ts` — add `listOccupied`
- Test: `backend/src/realtime/realtime.gateway.e2e-spec.ts` (full Nest app, real socket client)

**Interfaces:**
- Consumes: `JwtService` (session token verification), `EventEmitter2` (`'table.presence.changed'` from Tasks 5, 7, 8), `TablesService.listOccupied(excludeTableId?: number)`.
- Produces: `RealtimeGateway` — on connection, expects `auth: { token }` in the Socket.io handshake, verifies it the same way `SessionAuthGuard` does (valid JWT + session status `active` in DB), disconnects unauthenticated sockets; on the `'table.presence.changed'` event, broadcasts `'tables:update'` with the current occupied-table list (`{ tableId, number, activeSessionCount }[]`) to all connected sockets.

- [ ] **Step 1: Add `listOccupied` to `TablesService`**

Add to `backend/src/tables/tables.service.ts` (inside the class):

```typescript
  async listOccupied(excludeTableId?: number) {
    const tables = await this.prisma.table.findMany({
      where: {
        status: 'occupied',
        ...(excludeTableId ? { id: { not: excludeTableId } } : {}),
      },
      include: {
        sessions: { where: { status: 'active' } },
      },
      orderBy: { number: 'asc' },
    });

    return tables.map((t) => ({
      tableId: t.id,
      number: t.number,
      activeSessionCount: t.sessions.length,
    }));
  }
```

- [ ] **Step 2: Write the failing e2e test**

Create `backend/src/realtime/realtime.gateway.e2e-spec.ts`:

```typescript
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { TablesService } from '../tables/tables.service';

describe('RealtimeGateway (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessionsService: SessionsService;
  let tableAId: number;
  let tableBId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);

    prisma = app.get(PrismaService);
    sessionsService = app.get(SessionsService);
    const tablesService = app.get(TablesService);

    const tableA = await prisma.table.create({
      data: { number: 9401, qrTokenSecret: 'secret-9401' },
    });
    const tableB = await prisma.table.create({
      data: { number: 9402, qrTokenSecret: 'secret-9402' },
    });
    tableAId = tableA.id;
    tableBId = tableB.id;
    void tablesService;
  });

  afterAll(async () => {
    await prisma.clientSession.deleteMany({ where: { tableId: { in: [tableAId, tableBId] } } });
    await prisma.table.deleteMany({ where: { id: { in: [tableAId, tableBId] } } });
    await app.close();
  });

  function connect(token: string): Promise<Socket> {
    const address = app.getHttpServer().listen().address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return new Promise((resolve, reject) => {
      const socket = io(`http://localhost:${port}`, { auth: { token } });
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
  }

  it('broadcasts an updated occupied-table list when a new session joins', async () => {
    const { sessionToken: tokenA } = await sessionsService.createSession({
      tableId: tableAId,
      secret: 'secret-9401',
      pseudo: 'Alice',
    });
    const socketA = await connect(tokenA);

    const updatePromise = new Promise<any>((resolve) => {
      socketA.on('tables:update', resolve);
    });

    await sessionsService.createSession({
      tableId: tableBId,
      secret: 'secret-9402',
      pseudo: 'Bob',
    });

    const payload = await updatePromise;
    const tableBEntry = payload.find((t: any) => t.tableId === tableBId);
    expect(tableBEntry).toBeDefined();
    expect(tableBEntry.activeSessionCount).toBe(1);

    socketA.disconnect();
  });

  it('rejects a connection with no token', async () => {
    const address = app.getHttpServer().listen().address();
    const port = typeof address === 'object' && address ? address.port : 0;

    await expect(
      new Promise((resolve, reject) => {
        const socket = io(`http://localhost:${port}`, { auth: {} });
        socket.on('connect_error', reject);
        socket.on('connect', () => resolve(socket));
      }),
    ).rejects.toBeDefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npx jest realtime.gateway.e2e-spec.ts`
Expected: FAIL (no `RealtimeGateway`/`RealtimeModule` exist yet, `AppModule` doesn't wire them)

- [ ] **Step 4: Write the gateway**

Create `backend/src/realtime/realtime.gateway.ts`:

```typescript
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { TablesService } from '../tables/tables.service';
import { SessionTokenPayload } from '../sessions/session-auth.guard';

@WebSocketGateway({ cors: true })
export class RealtimeGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly tablesService: TablesService,
  ) {}

  async handleConnection(client: Socket) {
    const token = client.handshake.auth?.token as string | undefined;

    if (!token) {
      client.disconnect(true);
      return;
    }

    try {
      const payload = this.jwtService.verify<SessionTokenPayload>(token);
      const session = await this.prisma.clientSession.findUnique({
        where: { id: payload.sub },
      });

      if (!session || session.status !== 'active') {
        client.disconnect(true);
        return;
      }

      client.data.tableId = session.tableId;
    } catch {
      client.disconnect(true);
    }
  }

  @OnEvent('table.presence.changed')
  async handlePresenceChanged() {
    const occupied = await this.tablesService.listOccupied();
    this.server.emit('tables:update', occupied);
  }
}
```

Create `backend/src/realtime/realtime.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RealtimeGateway } from './realtime.gateway';
import { TablesModule } from '../tables/tables.module';

@Module({
  imports: [
    TablesModule,
    JwtModule.register({ secret: process.env.JWT_SECRET }),
  ],
  providers: [RealtimeGateway],
})
export class RealtimeModule {}
```

- [ ] **Step 5: Wire `EventEmitterModule` and `RealtimeModule` into `AppModule`**

Modify `backend/src/app.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { TablesModule } from './tables/tables.module';
import { SessionsModule } from './sessions/sessions.module';
import { RealtimeModule } from './realtime/realtime.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ConfigModule,
    PrismaModule,
    TablesModule,
    SessionsModule,
    RealtimeModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && npx jest realtime.gateway.e2e-spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add backend/src/realtime backend/src/tables backend/src/app.module.ts
git commit -m "feat: broadcast table presence over Socket.io on session changes"
```

---

### Task 10: Full-stack e2e smoke test (scan → session → presence)

**Files:**
- Create: `backend/test/session-flow.e2e-spec.ts`

**Interfaces:**
- Consumes: the full `AppModule` (all tasks above) via Supertest.
- Produces: nothing new — this is a regression test tying the REST surface together end-to-end.

- [ ] **Step 1: Write the failing test**

Create `backend/test/session-flow.e2e-spec.ts`:

```typescript
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Session flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tableId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    const table = await prisma.table.create({
      data: { number: 9501, qrTokenSecret: 'secret-9501' },
    });
    tableId = table.id;
  });

  afterAll(async () => {
    await prisma.clientSession.deleteMany({ where: { tableId } });
    await prisma.table.delete({ where: { id: tableId } });
    await app.close();
  });

  it('rejects scanning with the wrong secret', async () => {
    await request(app.getHttpServer())
      .post('/sessions')
      .send({ tableId, secret: 'wrong', pseudo: 'Alice' })
      .expect(401);
  });

  it('rejects scanning an unknown table', async () => {
    await request(app.getHttpServer())
      .post('/sessions')
      .send({ tableId: 9999999, secret: 'wrong', pseudo: 'Alice' })
      .expect(404);
  });

  it('creates a session, authenticates with the returned token, and can leave', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/sessions')
      .send({ tableId, secret: 'secret-9501', pseudo: 'Alice' })
      .expect(201);

    const { sessionToken, session } = createRes.body;
    expect(session.pseudo).toBe('Alice');

    await request(app.getHttpServer())
      .get('/sessions/me')
      .set('Authorization', `Bearer ${sessionToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('active');
      });

    await request(app.getHttpServer())
      .post(`/sessions/${session.id}/leave`)
      .set('Authorization', `Bearer ${sessionToken}`)
      .expect(201);

    await request(app.getHttpServer())
      .get('/sessions/me')
      .set('Authorization', `Bearer ${sessionToken}`)
      .expect(401);

    const table = await prisma.table.findUnique({ where: { id: tableId } });
    expect(table?.status).toBe('free');
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes incrementally**

Run: `cd backend && npx jest --config ./test/jest-e2e.json session-flow.e2e-spec.ts`
(If the project's default Nest e2e Jest config differs, use `npx jest session-flow.e2e-spec.ts` from `backend/` instead — either way, confirm it picks up `test/session-flow.e2e-spec.ts`.)
Expected: all three tests PASS, since every endpoint they exercise was built and unit-tested in Tasks 5–8. If any fail, the failure points at an integration gap between tasks (e.g. a route not registered) rather than at new code — fix the wiring, not the logic already covered by unit tests.

- [ ] **Step 3: Run the entire backend test suite**

Run: `cd backend && npx jest`
Expected: every spec file from Tasks 2–10 passes.

- [ ] **Step 4: Commit**

```bash
git add backend/test
git commit -m "test: add end-to-end session flow smoke test"
```

---

## Definition of Done for this Plan

- `docker compose -f backend/docker-compose.yml up -d && cd backend && npm run start:dev` boots cleanly and seeds `tableCount` tables from `config/restaurant.yaml`.
- `npx jest` (run from `backend/`) passes with zero failures.
- A client can: `POST /sessions` with a table's `{tableId, secret}` + pseudo → receive a session token → call `GET /sessions/me` → see itself in another connected client's `tables:update` Socket.io event → `POST /sessions/:id/leave` → the table frees up and disappears from others' `tables:update`.
- Messaging (`TableContact`, `Message`), voice calls (`Call`, Agora), the back-office (`StaffUser`), and push notifications are explicitly **out of scope** for this plan — they are covered by the next plans in the sequence (spec §14, steps 2–5).
