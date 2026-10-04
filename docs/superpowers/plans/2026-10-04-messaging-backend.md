# RestoTalk Messaging Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing RestoTalk NestJS backend with the messaging domain (`TableContact`, `Message`) so a table can request contact with another occupied table, send/receive messages once accepted, and see live updates over the existing Socket.io gateway.

**Architecture:** A new `MessagingModule` adds three controllers (`TablesDirectoryController`, `MessagesController`, `ContactsController`) and one `MessagingService` holding the contact/message business rules. It imports both `TablesModule` and `SessionsModule` — this placement (rather than inside `TablesModule`) deliberately avoids a circular import, since `SessionsModule` already imports `TablesModule`. The existing `RealtimeGateway` (unchanged in structure) gains table-scoped Socket.io rooms and three new `@OnEvent` listeners, so contact/message notifications reach only the two tables involved, unlike the existing global `tables:update` broadcast.

**Tech Stack:** NestJS 10, Prisma 5.20.0 + PostgreSQL (unchanged from Phase 1), `@nestjs/event-emitter`, Socket.io rooms, Jest + Supertest + `socket.io-client` for tests — no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-04-phase2-messaging-mobile-design.md` (sections 2, 3), which itself extends `docs/superpowers/specs/2026-10-04-restotalk-design.md` (sections 3, 5, 11/13).

## Global Constraints

- Authorization between two tables is one-time **per unordered pair**, not per direction (spec §5 / global spec §11): once a `TableContact` between table A and table B is `accepted`, every subsequent message between those two tables flows without a new request, regardless of who sends it.
- A `TableContact` lookup between two tables must check **both directions** (`table_a=A,table_b=B` OR `table_a=B,table_b=A`) — there is only ever one live (non-refused) contact per unordered pair at a time.
- After a contact is `refused`, a fresh attempt is allowed (global spec §11 ruling: "nouvelle tentative autorisée") — the next `sendMessage` call for that pair creates a brand-new `TableContact`, it does not reuse the refused one.
- No message content is ever revealed to the recipient before the owning `TableContact` is `accepted` (spec §5) — this applies to both the REST fetch (`GET /contacts/:id/messages`) and the Socket.io push (`contact:request` carries no message content).
- `POST /contacts/:contactId/respond` may only be called by a session belonging to the contact's destination table; `GET /contacts/:contactId/messages` may only be called by a session belonging to either of the contact's two tables (spec §3.4).
- Internal `EventEmitter2` event names use dot-separated names (`contact.request`, `contact.resolved`, `message.new`), matching the existing `table.presence.changed` convention; the corresponding Socket.io wire events use colon-separated names (`contact:request`, `contact:resolved`, `message:new`), matching the existing `tables:update` convention.
- All timestamps stored and compared in UTC (inherited, unchanged).
- No new npm dependencies — everything needed (`@nestjs/event-emitter`, `@nestjs/jwt`, Prisma, Socket.io) is already installed from Phase 1.

## Review Focus

- `POST /messages` to a `toTableId` that doesn't exist, or exists but is not currently `occupied`, must be rejected (404/400), not silently create a `TableContact` to a dead table.
- `POST /messages` where `toTableId` equals the caller's own `tableId` must be rejected — a table cannot request contact with itself.
- `POST /contacts/:contactId/respond` called by a session from the wrong table (not the contact's destination) must be rejected (403), not allowed to resolve someone else's pending request.
- `GET /contacts/:contactId/messages` called by a session belonging to neither table of that contact must be rejected (403) — message content must never leak to an unrelated table.
- Two messages sent back-to-back to the same still-`pending` contact must reuse that one `TableContact` (not create a second parallel pending request for the same pair) — only a `refused` prior contact triggers a fresh one.

---

## File Structure

```
backend/
  prisma/
    schema.prisma               (modify: add TableContact, Message models + enum)
  src/
    sessions/
      sessions.module.ts        (modify: export SessionAuthGuard)
    realtime/
      realtime.gateway.ts       (modify: join table-scoped rooms, 3 new @OnEvent listeners)
    messaging/
      messaging.module.ts
      messaging.service.ts
      messaging.service.spec.ts
      dto/
        send-message.dto.ts
        respond-contact.dto.ts
      tables-directory.controller.ts
      tables-directory.controller.e2e-spec.ts
      messages.controller.ts
      contacts.controller.ts
  test/
    messaging-flow.e2e-spec.ts
```

---

### Task 1: Prisma schema — `TableContact` and `Message`

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Test: `backend/src/messaging/messaging.service.spec.ts` (initial smoke test for the two new models, extended by later tasks)

**Interfaces:**
- Consumes: existing `Table`, `ClientSession` models (Phase 1).
- Produces: Prisma models `TableContact { id, tableAId, tableBId, status, requestedBySessionId, createdAt, respondedAt }` and `Message { id, contactId, senderSessionId, kind, predefinedCode, content, createdAt }`, enums `TableContactStatus { pending, accepted, refused }` and `MessageKind { predefined, freetext }`.

- [ ] **Step 1: Add the two models to the Prisma schema**

Append to `backend/prisma/schema.prisma` (after the existing `ClientSession` model):

```prisma
enum TableContactStatus {
  pending
  accepted
  refused
}

enum MessageKind {
  predefined
  freetext
}

model TableContact {
  id                   Int                 @id @default(autoincrement())
  tableAId             Int                 @map("table_a_id")
  tableA               Table               @relation("ContactTableA", fields: [tableAId], references: [id])
  tableBId             Int                 @map("table_b_id")
  tableB               Table               @relation("ContactTableB", fields: [tableBId], references: [id])
  status               TableContactStatus  @default(pending)
  requestedBySessionId Int                 @map("requested_by_session_id")
  requestedBySession   ClientSession       @relation(fields: [requestedBySessionId], references: [id])
  createdAt            DateTime            @default(now()) @map("created_at")
  respondedAt          DateTime?           @map("responded_at")
  messages             Message[]

  @@map("table_contacts")
}

model Message {
  id              Int           @id @default(autoincrement())
  contactId       Int           @map("contact_id")
  contact         TableContact  @relation(fields: [contactId], references: [id])
  senderSessionId Int           @map("sender_session_id")
  senderSession   ClientSession @relation(fields: [senderSessionId], references: [id])
  kind            MessageKind
  predefinedCode  String?       @map("predefined_code")
  content         String
  createdAt       DateTime      @default(now()) @map("created_at")

  @@map("messages")
}
```

Add the two reverse-relation fields Prisma requires on the existing models. Modify `backend/prisma/schema.prisma`'s `Table` model to add:

```prisma
  contactsAsA   TableContact[] @relation("ContactTableA")
  contactsAsB   TableContact[] @relation("ContactTableB")
```

(insert these two lines inside the existing `model Table { ... }` block, after the `sessions` field)

and modify the existing `ClientSession` model to add:

```prisma
  requestedContacts TableContact[]
  sentMessages      Message[]
```

(insert these two lines inside the existing `model ClientSession { ... }` block, after the `status` field)

- [ ] **Step 2: Generate the migration**

```bash
cd backend
npx prisma migrate dev --name add_messaging
```

Expected: a new `backend/prisma/migrations/<timestamp>_add_messaging/migration.sql` is created and applied without errors.

- [ ] **Step 3: Write the failing test**

Create `backend/src/messaging/messaging.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';

describe('Messaging Prisma models', () => {
  let prisma: PrismaService;
  let tableAId: number;
  let tableBId: number;
  let sessionAId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    await prisma.onModuleInit();

    const tableA = await prisma.table.create({
      data: { number: 9601, qrTokenSecret: 'secret-9601' },
    });
    const tableB = await prisma.table.create({
      data: { number: 9602, qrTokenSecret: 'secret-9602' },
    });
    tableAId = tableA.id;
    tableBId = tableB.id;

    const sessionA = await prisma.clientSession.create({
      data: { tableId: tableAId, pseudo: 'Alice', status: 'active' },
    });
    sessionAId = sessionA.id;
  });

  afterAll(async () => {
    await prisma.message.deleteMany({});
    await prisma.tableContact.deleteMany({
      where: { OR: [{ tableAId }, { tableBId }] },
    });
    await prisma.clientSession.deleteMany({ where: { tableId: { in: [tableAId, tableBId] } } });
    await prisma.table.deleteMany({ where: { id: { in: [tableAId, tableBId] } } });
    await prisma.onModuleDestroy();
  });

  it('creates a TableContact and a Message referencing it', async () => {
    const contact = await prisma.tableContact.create({
      data: { tableAId, tableBId, requestedBySessionId: sessionAId },
    });
    expect(contact.status).toBe('pending');

    const message = await prisma.message.create({
      data: {
        contactId: contact.id,
        senderSessionId: sessionAId,
        kind: 'freetext',
        content: 'Salut !',
      },
    });

    const found = await prisma.message.findUnique({ where: { id: message.id } });
    expect(found?.content).toBe('Salut !');
    expect(found?.contactId).toBe(contact.id);
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest messaging.service.spec.ts`
Expected: PASS (1 test) — confirms the migration applied correctly and the models/relations work.

- [ ] **Step 5: Commit**

```bash
git add backend/prisma backend/src/messaging/messaging.service.spec.ts
git commit -m "feat: add TableContact and Message Prisma models"
```

---

### Task 2: `GET /tables/occupied`

**Files:**
- Create: `backend/src/messaging/messaging.module.ts`
- Create: `backend/src/messaging/tables-directory.controller.ts`
- Modify: `backend/src/sessions/sessions.module.ts` — export `SessionAuthGuard`
- Modify: `backend/src/app.module.ts` — import `MessagingModule`
- Test: `backend/src/messaging/tables-directory.controller.e2e-spec.ts`

**Interfaces:**
- Consumes: `TablesService.listOccupied(excludeTableId?: number)` (already implemented in Phase 1, in `backend/src/tables/tables.service.ts`), `SessionAuthGuard` (Phase 1, `backend/src/sessions/session-auth.guard.ts`).
- Produces: `GET /tables/occupied` route (guarded), establishes `MessagingModule` as the home for every controller this plan adds.

- [ ] **Step 1: Export `SessionAuthGuard` from `SessionsModule`**

Modify `backend/src/sessions/sessions.module.ts` — add `SessionAuthGuard` to the `exports` array:

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { SessionAuthGuard } from './session-auth.guard';
import { SessionExpirationService } from './session-expiration.service';
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
  providers: [SessionsService, SessionAuthGuard, SessionExpirationService],
  exports: [SessionsService, SessionAuthGuard],
})
export class SessionsModule {}
```

(The only change is adding `SessionAuthGuard` to `exports`.)

- [ ] **Step 2: Write the failing e2e test**

Create `backend/src/messaging/tables-directory.controller.e2e-spec.ts`:

```typescript
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';

describe('GET /tables/occupied (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessionsService: SessionsService;
  let tableAId: number;
  let tableBId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    sessionsService = app.get(SessionsService);

    const tableA = await prisma.table.create({
      data: { number: 9611, qrTokenSecret: 'secret-9611' },
    });
    const tableB = await prisma.table.create({
      data: { number: 9612, qrTokenSecret: 'secret-9612' },
    });
    tableAId = tableA.id;
    tableBId = tableB.id;
  });

  afterAll(async () => {
    await prisma.clientSession.deleteMany({ where: { tableId: { in: [tableAId, tableBId] } } });
    await prisma.table.deleteMany({ where: { id: { in: [tableAId, tableBId] } } });
    await app.close();
  });

  it('lists occupied tables excluding the caller\'s own table', async () => {
    const { sessionToken: tokenA } = await sessionsService.createSession({
      tableId: tableAId,
      secret: 'secret-9611',
      pseudo: 'Alice',
    });
    await sessionsService.createSession({
      tableId: tableBId,
      secret: 'secret-9612',
      pseudo: 'Bob',
    });

    const res = await request(app.getHttpServer())
      .get('/tables/occupied')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    const tableIds = res.body.map((t: any) => t.tableId);
    expect(tableIds).toContain(tableBId);
    expect(tableIds).not.toContain(tableAId);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/tables/occupied').expect(401);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npx jest tables-directory.controller.e2e-spec.ts`
Expected: FAIL with "Cannot find module '../messaging/...'" or a 404 — the route doesn't exist yet.

- [ ] **Step 4: Write the controller and module**

Create `backend/src/messaging/tables-directory.controller.ts`:

```typescript
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../sessions/session-auth.guard';
import { TablesService } from '../tables/tables.service';

@UseGuards(SessionAuthGuard)
@Controller('tables')
export class TablesDirectoryController {
  constructor(private readonly tablesService: TablesService) {}

  @Get('occupied')
  async occupied(@Req() req: any) {
    return this.tablesService.listOccupied(req.session.tableId);
  }
}
```

Create `backend/src/messaging/messaging.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { TablesModule } from '../tables/tables.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TablesDirectoryController } from './tables-directory.controller';

@Module({
  imports: [TablesModule, SessionsModule],
  controllers: [TablesDirectoryController],
})
export class MessagingModule {}
```

- [ ] **Step 5: Wire `MessagingModule` into `AppModule`**

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
import { MessagingModule } from './messaging/messaging.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ConfigModule,
    PrismaModule,
    TablesModule,
    SessionsModule,
    RealtimeModule,
    MessagingModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && npx jest tables-directory.controller.e2e-spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add backend/src/messaging backend/src/sessions/sessions.module.ts backend/src/app.module.ts
git commit -m "feat: add GET /tables/occupied endpoint"
```

---

### Task 3: `POST /messages` — send a message, create/reuse a contact

**Files:**
- Create: `backend/src/messaging/dto/send-message.dto.ts`
- Create: `backend/src/messaging/messaging.service.ts`
- Create: `backend/src/messaging/messages.controller.ts`
- Modify: `backend/src/messaging/messaging.module.ts` — add provider/controller
- Modify: `backend/src/realtime/realtime.gateway.ts` — join table-scoped rooms, add `contact:request`/`message:new` listeners
- Test: extend `backend/src/messaging/messaging.service.spec.ts`

**Interfaces:**
- Consumes: `TablesService.findById` (Phase 1), `SessionTokenPayload` (`backend/src/sessions/session-auth.guard.ts`).
- Produces: `MessagingService.sendMessage(session: ClientSession, dto: SendMessageDto): Promise<{ status: 'sent' | 'pending_approval'; contactId: number; message?: Message }>`. Emits `'contact.request'` (payload `{ contactId: number; toTableId: number; fromTableId: number; fromTableNumber: number }`) when a fresh pending contact is created, or `'message.new'` (payload `{ contactId: number; toTableId: number; message: { id, kind, predefinedCode, content, senderSessionId, createdAt } }`) when delivered to an already-`accepted` contact.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/messaging/messaging.service.spec.ts` (new `describe` block, after the existing one; add the needed imports at the top of the file: `EventEmitter2, EventEmitterModule` from `'@nestjs/event-emitter'`, `NotFoundException, BadRequestException` from `'@nestjs/common'`, `TablesService` from `'../tables/tables.service'`, `MessagingService` from `'./messaging.service'`):

```typescript
describe('MessagingService.sendMessage', () => {
  let prisma: PrismaService;
  let service: MessagingService;
  let events: EventEmitter2;
  let tableAId: number;
  let tableBId: number;
  let sessionA: { id: number; tableId: number };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [PrismaService, TablesService, MessagingService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(MessagingService);
    events = moduleRef.get(EventEmitter2);
    await prisma.onModuleInit();

    const tableA = await prisma.table.create({
      data: { number: 9621, qrTokenSecret: 'secret-9621', status: 'occupied' },
    });
    const tableB = await prisma.table.create({
      data: { number: 9622, qrTokenSecret: 'secret-9622', status: 'occupied' },
    });
    tableAId = tableA.id;
    tableBId = tableB.id;

    const session = await prisma.clientSession.create({
      data: { tableId: tableAId, pseudo: 'Alice', status: 'active' },
    });
    sessionA = { id: session.id, tableId: tableAId };
  });

  afterEach(async () => {
    await prisma.message.deleteMany({});
    await prisma.tableContact.deleteMany({
      where: { OR: [{ tableAId }, { tableBId }] },
    });
  });

  afterAll(async () => {
    await prisma.clientSession.deleteMany({ where: { tableId: { in: [tableAId, tableBId] } } });
    await prisma.table.deleteMany({ where: { id: { in: [tableAId, tableBId] } } });
    await prisma.onModuleDestroy();
  });

  it('creates a pending contact and emits contact.request on first message', async () => {
    const emitSpy = jest.spyOn(events, 'emit');

    const result = await service.sendMessage(sessionA as any, {
      toTableId: tableBId,
      kind: 'freetext',
      content: 'Salut la table 2 !',
    });

    expect(result.status).toBe('pending_approval');
    const contact = await prisma.tableContact.findUnique({ where: { id: result.contactId } });
    expect(contact?.status).toBe('pending');
    const messages = await prisma.message.findMany({ where: { contactId: result.contactId } });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Salut la table 2 !');

    expect(emitSpy).toHaveBeenCalledWith(
      'contact.request',
      expect.objectContaining({ contactId: result.contactId, toTableId: tableBId, fromTableId: tableAId }),
    );
    emitSpy.mockRestore();
  });

  it('reuses the same pending contact for a second message before it is resolved', async () => {
    const first = await service.sendMessage(sessionA as any, {
      toTableId: tableBId,
      kind: 'freetext',
      content: 'Premier message',
    });
    const second = await service.sendMessage(sessionA as any, {
      toTableId: tableBId,
      kind: 'freetext',
      content: 'Deuxième message',
    });

    expect(second.contactId).toBe(first.contactId);
    const messages = await prisma.message.findMany({ where: { contactId: first.contactId } });
    expect(messages).toHaveLength(2);
  });

  it('sends directly and emits message.new when the contact is already accepted', async () => {
    const contact = await prisma.tableContact.create({
      data: {
        tableAId,
        tableBId,
        requestedBySessionId: sessionA.id,
        status: 'accepted',
        respondedAt: new Date(),
      },
    });
    const emitSpy = jest.spyOn(events, 'emit');

    const result = await service.sendMessage(sessionA as any, {
      toTableId: tableBId,
      kind: 'freetext',
      content: 'On est déjà en contact',
    });

    expect(result.status).toBe('sent');
    expect(result.contactId).toBe(contact.id);
    expect(emitSpy).toHaveBeenCalledWith(
      'message.new',
      expect.objectContaining({ contactId: contact.id, toTableId: tableBId }),
    );
    emitSpy.mockRestore();
  });

  it('rejects messaging an unknown table', async () => {
    await expect(
      service.sendMessage(sessionA as any, { toTableId: 999999, kind: 'freetext', content: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects messaging a table that exists but is not occupied', async () => {
    const freeTable = await prisma.table.create({
      data: { number: 9623, qrTokenSecret: 'secret-9623', status: 'free' },
    });

    await expect(
      service.sendMessage(sessionA as any, {
        toTableId: freeTable.id,
        kind: 'freetext',
        content: 'x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await prisma.table.delete({ where: { id: freeTable.id } });
  });

  it('rejects messaging your own table', async () => {
    await expect(
      service.sendMessage(sessionA as any, { toTableId: tableAId, kind: 'freetext', content: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates a fresh contact after a prior one was refused', async () => {
    const refused = await prisma.tableContact.create({
      data: {
        tableAId,
        tableBId,
        requestedBySessionId: sessionA.id,
        status: 'refused',
        respondedAt: new Date(),
      },
    });

    const result = await service.sendMessage(sessionA as any, {
      toTableId: tableBId,
      kind: 'freetext',
      content: 'Nouvelle tentative',
    });

    expect(result.contactId).not.toBe(refused.id);
    const newContact = await prisma.tableContact.findUnique({ where: { id: result.contactId } });
    expect(newContact?.status).toBe('pending');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest messaging.service.spec.ts`
Expected: FAIL — `MessagingService` doesn't exist yet.

- [ ] **Step 3: Write the DTO and service**

Create `backend/src/messaging/dto/send-message.dto.ts`:

```typescript
export class SendMessageDto {
  toTableId: number;
  kind: 'predefined' | 'freetext';
  predefinedCode?: string;
  content: string;
}
```

Create `backend/src/messaging/messaging.service.ts`:

```typescript
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClientSession, Message } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TablesService } from '../tables/tables.service';
import { SendMessageDto } from './dto/send-message.dto';

@Injectable()
export class MessagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tablesService: TablesService,
    private readonly events: EventEmitter2,
  ) {}

  private async findLiveContact(tableAId: number, tableBId: number) {
    return this.prisma.tableContact.findFirst({
      where: {
        status: { in: ['pending', 'accepted'] },
        OR: [
          { tableAId, tableBId },
          { tableAId: tableBId, tableBId: tableAId },
        ],
      },
    });
  }

  async sendMessage(
    session: ClientSession,
    dto: SendMessageDto,
  ): Promise<{ status: 'sent' | 'pending_approval'; contactId: number; message?: Message }> {
    if (dto.toTableId === session.tableId) {
      throw new BadRequestException('Cannot message your own table');
    }

    const targetTable = await this.tablesService.findById(dto.toTableId);
    if (!targetTable) {
      throw new NotFoundException('Unknown table');
    }
    if (targetTable.status !== 'occupied') {
      throw new BadRequestException('Target table is not occupied');
    }

    let contact = await this.findLiveContact(session.tableId, dto.toTableId);
    let isNewContact = false;

    if (!contact) {
      contact = await this.prisma.tableContact.create({
        data: {
          tableAId: session.tableId,
          tableBId: dto.toTableId,
          requestedBySessionId: session.id,
        },
      });
      isNewContact = true;
    }

    const message = await this.prisma.message.create({
      data: {
        contactId: contact.id,
        senderSessionId: session.id,
        kind: dto.kind,
        predefinedCode: dto.predefinedCode ?? null,
        content: dto.content,
      },
    });

    if (contact.status === 'accepted') {
      this.events.emit('message.new', {
        contactId: contact.id,
        toTableId: dto.toTableId,
        message: {
          id: message.id,
          kind: message.kind,
          predefinedCode: message.predefinedCode,
          content: message.content,
          senderSessionId: message.senderSessionId,
          createdAt: message.createdAt,
        },
      });
      this.events.emit('message.new', {
        contactId: contact.id,
        toTableId: session.tableId,
        message: {
          id: message.id,
          kind: message.kind,
          predefinedCode: message.predefinedCode,
          content: message.content,
          senderSessionId: message.senderSessionId,
          createdAt: message.createdAt,
        },
      });
      return { status: 'sent', contactId: contact.id, message };
    }

    if (isNewContact) {
      this.events.emit('contact.request', {
        contactId: contact.id,
        toTableId: dto.toTableId,
        fromTableId: session.tableId,
        fromTableNumber: (await this.tablesService.findById(session.tableId))?.number,
      });
    }

    return { status: 'pending_approval', contactId: contact.id };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest messaging.service.spec.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Add table-scoped rooms and the two gateway listeners**

Modify `backend/src/realtime/realtime.gateway.ts` — add `socket.join` inside `authenticate`, and two new `@OnEvent` listeners. Full updated file:

```typescript
import {
  OnGatewayInit,
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
export class RealtimeGateway implements OnGatewayInit {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly tablesService: TablesService,
  ) {}

  afterInit(server: Server) {
    server.use((socket: Socket, next: (err?: Error) => void) => {
      void this.authenticate(socket, next);
    });
  }

  private async authenticate(socket: Socket, next: (err?: Error) => void) {
    const token = socket.handshake.auth?.token as string | undefined;

    if (!token) {
      next(new Error('Unauthorized'));
      return;
    }

    try {
      const payload = this.jwtService.verify<SessionTokenPayload>(token);
      const session = await this.prisma.clientSession.findUnique({
        where: { id: payload.sub },
      });

      if (!session || session.status !== 'active') {
        next(new Error('Unauthorized'));
        return;
      }

      socket.data.tableId = session.tableId;
      socket.join(`table:${session.tableId}`);
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  }

  @OnEvent('table.presence.changed')
  async handlePresenceChanged() {
    const occupied = await this.tablesService.listOccupied();
    this.server.emit('tables:update', occupied);
  }

  @OnEvent('contact.request')
  handleContactRequest(payload: {
    contactId: number;
    toTableId: number;
    fromTableId: number;
    fromTableNumber: number;
  }) {
    this.server.to(`table:${payload.toTableId}`).emit('contact:request', {
      contactId: payload.contactId,
      fromTableId: payload.fromTableId,
      fromTableNumber: payload.fromTableNumber,
    });
  }

  @OnEvent('message.new')
  handleMessageNew(payload: { contactId: number; toTableId: number; message: unknown }) {
    this.server.to(`table:${payload.toTableId}`).emit('message:new', {
      contactId: payload.contactId,
      message: payload.message,
    });
  }
}
```

- [ ] **Step 6: Wire the controller and module**

Create `backend/src/messaging/messages.controller.ts`:

```typescript
import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../sessions/session-auth.guard';
import { MessagingService } from './messaging.service';
import { SendMessageDto } from './dto/send-message.dto';

@UseGuards(SessionAuthGuard)
@Controller('messages')
export class MessagesController {
  constructor(private readonly messagingService: MessagingService) {}

  @Post()
  async send(@Req() req: any, @Body() dto: SendMessageDto) {
    return this.messagingService.sendMessage(req.session, dto);
  }
}
```

Modify `backend/src/messaging/messaging.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { TablesModule } from '../tables/tables.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TablesDirectoryController } from './tables-directory.controller';
import { MessagesController } from './messages.controller';
import { MessagingService } from './messaging.service';

@Module({
  imports: [TablesModule, SessionsModule],
  controllers: [TablesDirectoryController, MessagesController],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
```

- [ ] **Step 7: Run the full suite to verify no regressions**

Run: `cd backend && npx jest`
Expected: all suites pass, including Phase 1's `realtime.gateway.e2e-spec.ts` (room-joining is additive and doesn't change the existing `tables:update` broadcast behavior).

- [ ] **Step 8: Commit**

```bash
git add backend/src/messaging backend/src/realtime/realtime.gateway.ts
git commit -m "feat: add POST /messages with contact creation/reuse and socket events"
```

---

### Task 4: `POST /contacts/:contactId/respond`

**Files:**
- Create: `backend/src/messaging/dto/respond-contact.dto.ts`
- Create: `backend/src/messaging/contacts.controller.ts`
- Modify: `backend/src/messaging/messaging.service.ts` — add `respondToContact`
- Modify: `backend/src/messaging/messaging.module.ts` — add controller
- Modify: `backend/src/realtime/realtime.gateway.ts` — add `contact:resolved` listener
- Test: extend `backend/src/messaging/messaging.service.spec.ts`

**Interfaces:**
- Consumes: `MessagingService`'s existing `findLiveContact` pattern (private helper reused by lookup-by-id here), `ClientSession` type.
- Produces: `MessagingService.respondToContact(session: ClientSession, contactId: number, accept: boolean): Promise<TableContact>` — throws `NotFoundException` for an unknown contact, `ForbiddenException` if the session's table isn't the contact's `tableBId` (the destination), `BadRequestException` if the contact isn't `pending`. Emits `'contact.resolved'` (payload `{ contactId, toTableId, status }`) and, if accepted, `'message.new'` for every message already stored under that contact (the initial message(s) sent while pending).

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/messaging/messaging.service.spec.ts` (new `describe` block; add `ForbiddenException` to the `@nestjs/common` import at the top of the file):

```typescript
describe('MessagingService.respondToContact', () => {
  let prisma: PrismaService;
  let service: MessagingService;
  let events: EventEmitter2;
  let tableAId: number;
  let tableBId: number;
  let sessionA: { id: number; tableId: number };
  let sessionB: { id: number; tableId: number };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [PrismaService, TablesService, MessagingService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(MessagingService);
    events = moduleRef.get(EventEmitter2);
    await prisma.onModuleInit();

    const tableA = await prisma.table.create({
      data: { number: 9631, qrTokenSecret: 'secret-9631', status: 'occupied' },
    });
    const tableB = await prisma.table.create({
      data: { number: 9632, qrTokenSecret: 'secret-9632', status: 'occupied' },
    });
    tableAId = tableA.id;
    tableBId = tableB.id;

    const sA = await prisma.clientSession.create({
      data: { tableId: tableAId, pseudo: 'Alice', status: 'active' },
    });
    const sB = await prisma.clientSession.create({
      data: { tableId: tableBId, pseudo: 'Bob', status: 'active' },
    });
    sessionA = { id: sA.id, tableId: tableAId };
    sessionB = { id: sB.id, tableId: tableBId };
  });

  afterEach(async () => {
    await prisma.message.deleteMany({});
    await prisma.tableContact.deleteMany({
      where: { OR: [{ tableAId }, { tableBId }] },
    });
  });

  afterAll(async () => {
    await prisma.clientSession.deleteMany({ where: { tableId: { in: [tableAId, tableBId] } } });
    await prisma.table.deleteMany({ where: { id: { in: [tableAId, tableBId] } } });
    await prisma.onModuleDestroy();
  });

  it('accepts a pending contact and delivers its queued message', async () => {
    const { contactId } = await service.sendMessage(sessionA as any, {
      toTableId: tableBId,
      kind: 'freetext',
      content: 'Coucou',
    });
    const emitSpy = jest.spyOn(events, 'emit');

    const resolved = await service.respondToContact(sessionB as any, contactId, true);

    expect(resolved.status).toBe('accepted');
    expect(resolved.respondedAt).not.toBeNull();
    expect(emitSpy).toHaveBeenCalledWith(
      'contact.resolved',
      expect.objectContaining({ contactId, toTableId: tableAId, status: 'accepted' }),
    );
    expect(emitSpy).toHaveBeenCalledWith(
      'message.new',
      expect.objectContaining({ contactId, toTableId: tableBId }),
    );
    emitSpy.mockRestore();
  });

  it('refuses a pending contact without delivering its message', async () => {
    const { contactId } = await service.sendMessage(sessionA as any, {
      toTableId: tableBId,
      kind: 'freetext',
      content: 'Coucou',
    });

    const resolved = await service.respondToContact(sessionB as any, contactId, false);

    expect(resolved.status).toBe('refused');
  });

  it('rejects a response from a session not belonging to the destination table', async () => {
    const { contactId } = await service.sendMessage(sessionA as any, {
      toTableId: tableBId,
      kind: 'freetext',
      content: 'Coucou',
    });

    await expect(
      service.respondToContact(sessionA as any, contactId, true),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects responding to an already-resolved contact', async () => {
    const { contactId } = await service.sendMessage(sessionA as any, {
      toTableId: tableBId,
      kind: 'freetext',
      content: 'Coucou',
    });
    await service.respondToContact(sessionB as any, contactId, true);

    await expect(
      service.respondToContact(sessionB as any, contactId, true),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects responding to an unknown contact', async () => {
    await expect(
      service.respondToContact(sessionB as any, 999999, true),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest messaging.service.spec.ts`
Expected: FAIL — `respondToContact` doesn't exist yet.

- [ ] **Step 3: Implement `respondToContact`**

Add to `backend/src/messaging/messaging.service.ts` (inside the class, after `sendMessage`; add `ForbiddenException` and `TableContact` to the existing imports):

```typescript
  async respondToContact(
    session: ClientSession,
    contactId: number,
    accept: boolean,
  ): Promise<TableContact> {
    const contact = await this.prisma.tableContact.findUnique({ where: { id: contactId } });

    if (!contact) {
      throw new NotFoundException('Unknown contact');
    }

    if (contact.tableBId !== session.tableId) {
      throw new ForbiddenException('Only the destination table can respond to this contact');
    }

    if (contact.status !== 'pending') {
      throw new BadRequestException('Contact is already resolved');
    }

    const updated = await this.prisma.tableContact.update({
      where: { id: contactId },
      data: { status: accept ? 'accepted' : 'refused', respondedAt: new Date() },
    });

    this.events.emit('contact.resolved', {
      contactId,
      toTableId: contact.tableAId,
      status: updated.status,
    });

    if (accept) {
      const messages = await this.prisma.message.findMany({ where: { contactId } });
      for (const message of messages) {
        const payload = {
          id: message.id,
          kind: message.kind,
          predefinedCode: message.predefinedCode,
          content: message.content,
          senderSessionId: message.senderSessionId,
          createdAt: message.createdAt,
        };
        this.events.emit('message.new', { contactId, toTableId: contact.tableAId, message: payload });
        this.events.emit('message.new', { contactId, toTableId: contact.tableBId, message: payload });
      }
    }

    return updated;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest messaging.service.spec.ts`
Expected: PASS (13 tests total across both describe blocks)

- [ ] **Step 5: Add the `contact:resolved` gateway listener**

Add to `backend/src/realtime/realtime.gateway.ts` (inside the class, after `handleContactRequest`):

```typescript
  @OnEvent('contact.resolved')
  handleContactResolved(payload: { contactId: number; toTableId: number; status: string }) {
    this.server.to(`table:${payload.toTableId}`).emit('contact:resolved', {
      contactId: payload.contactId,
      status: payload.status,
    });
  }
```

- [ ] **Step 6: Wire the controller**

Create `backend/src/messaging/dto/respond-contact.dto.ts`:

```typescript
export class RespondContactDto {
  accept: boolean;
}
```

Create `backend/src/messaging/contacts.controller.ts`:

```typescript
import { Body, Controller, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../sessions/session-auth.guard';
import { MessagingService } from './messaging.service';
import { RespondContactDto } from './dto/respond-contact.dto';

@UseGuards(SessionAuthGuard)
@Controller('contacts')
export class ContactsController {
  constructor(private readonly messagingService: MessagingService) {}

  @Post(':contactId/respond')
  async respond(
    @Req() req: any,
    @Param('contactId', ParseIntPipe) contactId: number,
    @Body() dto: RespondContactDto,
  ) {
    const updated = await this.messagingService.respondToContact(req.session, contactId, dto.accept);
    return { status: updated.status };
  }
}
```

Modify `backend/src/messaging/messaging.module.ts` — add `ContactsController` to `controllers`:

```typescript
import { Module } from '@nestjs/common';
import { TablesModule } from '../tables/tables.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TablesDirectoryController } from './tables-directory.controller';
import { MessagesController } from './messages.controller';
import { ContactsController } from './contacts.controller';
import { MessagingService } from './messaging.service';

@Module({
  imports: [TablesModule, SessionsModule],
  controllers: [TablesDirectoryController, MessagesController, ContactsController],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/messaging backend/src/realtime/realtime.gateway.ts
git commit -m "feat: add POST /contacts/:id/respond with message delivery on accept"
```

---

### Task 5: `GET /contacts/:contactId/messages`

**Files:**
- Modify: `backend/src/messaging/messaging.service.ts` — add `getMessages`
- Modify: `backend/src/messaging/contacts.controller.ts` — add route
- Test: extend `backend/src/messaging/messaging.service.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `MessagingService.getMessages(session: ClientSession, contactId: number): Promise<Message[]>` — throws `NotFoundException` for an unknown contact, `ForbiddenException` if the session's table is neither `tableAId` nor `tableBId`, `BadRequestException` if the contact is still `pending` (no messages are visible before acceptance) or `refused`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/messaging/messaging.service.spec.ts` (new `describe` block):

```typescript
describe('MessagingService.getMessages', () => {
  let prisma: PrismaService;
  let service: MessagingService;
  let tableAId: number;
  let tableBId: number;
  let tableCId: number;
  let sessionA: { id: number; tableId: number };
  let sessionB: { id: number; tableId: number };
  let sessionC: { id: number; tableId: number };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [PrismaService, TablesService, MessagingService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(MessagingService);
    await prisma.onModuleInit();

    const tableA = await prisma.table.create({
      data: { number: 9641, qrTokenSecret: 'secret-9641', status: 'occupied' },
    });
    const tableB = await prisma.table.create({
      data: { number: 9642, qrTokenSecret: 'secret-9642', status: 'occupied' },
    });
    const tableC = await prisma.table.create({
      data: { number: 9643, qrTokenSecret: 'secret-9643', status: 'occupied' },
    });
    tableAId = tableA.id;
    tableBId = tableB.id;
    tableCId = tableC.id;

    const sA = await prisma.clientSession.create({
      data: { tableId: tableAId, pseudo: 'Alice', status: 'active' },
    });
    const sB = await prisma.clientSession.create({
      data: { tableId: tableBId, pseudo: 'Bob', status: 'active' },
    });
    const sC = await prisma.clientSession.create({
      data: { tableId: tableCId, pseudo: 'Carol', status: 'active' },
    });
    sessionA = { id: sA.id, tableId: tableAId };
    sessionB = { id: sB.id, tableId: tableBId };
    sessionC = { id: sC.id, tableId: tableCId };
  });

  afterEach(async () => {
    await prisma.message.deleteMany({});
    await prisma.tableContact.deleteMany({
      where: { OR: [{ tableAId }, { tableBId }] },
    });
  });

  afterAll(async () => {
    await prisma.clientSession.deleteMany({
      where: { tableId: { in: [tableAId, tableBId, tableCId] } },
    });
    await prisma.table.deleteMany({ where: { id: { in: [tableAId, tableBId, tableCId] } } });
    await prisma.onModuleDestroy();
  });

  it('returns messages for an accepted contact to either participant', async () => {
    const { contactId } = await service.sendMessage(sessionA as any, {
      toTableId: tableBId,
      kind: 'freetext',
      content: 'Coucou',
    });
    await service.respondToContact(sessionB as any, contactId, true);

    const asSender = await service.getMessages(sessionA as any, contactId);
    const asRecipient = await service.getMessages(sessionB as any, contactId);

    expect(asSender).toHaveLength(1);
    expect(asRecipient).toHaveLength(1);
    expect(asSender[0].content).toBe('Coucou');
  });

  it('rejects fetching messages for a contact still pending', async () => {
    const { contactId } = await service.sendMessage(sessionA as any, {
      toTableId: tableBId,
      kind: 'freetext',
      content: 'Coucou',
    });

    await expect(service.getMessages(sessionB as any, contactId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a session from an unrelated table', async () => {
    const { contactId } = await service.sendMessage(sessionA as any, {
      toTableId: tableBId,
      kind: 'freetext',
      content: 'Coucou',
    });
    await service.respondToContact(sessionB as any, contactId, true);

    await expect(service.getMessages(sessionC as any, contactId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest messaging.service.spec.ts`
Expected: FAIL — `getMessages` doesn't exist yet.

- [ ] **Step 3: Implement `getMessages`**

Add to `backend/src/messaging/messaging.service.ts` (inside the class):

```typescript
  async getMessages(session: ClientSession, contactId: number): Promise<Message[]> {
    const contact = await this.prisma.tableContact.findUnique({ where: { id: contactId } });

    if (!contact) {
      throw new NotFoundException('Unknown contact');
    }

    if (contact.tableAId !== session.tableId && contact.tableBId !== session.tableId) {
      throw new ForbiddenException('Not a participant of this contact');
    }

    if (contact.status !== 'accepted') {
      throw new BadRequestException('Contact is not accepted');
    }

    return this.prisma.message.findMany({
      where: { contactId },
      orderBy: { createdAt: 'asc' },
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest messaging.service.spec.ts`
Expected: PASS (16 tests total across all three describe blocks)

- [ ] **Step 5: Wire the controller route**

Add to `backend/src/messaging/contacts.controller.ts`:

```typescript
  @Get(':contactId/messages')
  async messages(@Req() req: any, @Param('contactId', ParseIntPipe) contactId: number) {
    return this.messagingService.getMessages(req.session, contactId);
  }
```

(Add `Get` to the existing `@nestjs/common` import line in that file.)

- [ ] **Step 6: Commit**

```bash
git add backend/src/messaging
git commit -m "feat: add GET /contacts/:id/messages"
```

---

### Task 6: Full-stack e2e smoke test (table scan → contact request → accept → message history)

**Files:**
- Create: `backend/test/messaging-flow.e2e-spec.ts`

**Interfaces:**
- Consumes: the full `AppModule` (all tasks above) via Supertest and a real `socket.io-client`.
- Produces: nothing new — this is a regression test tying the messaging REST surface and its Socket.io events together end-to-end.

- [ ] **Step 1: Write the failing test**

Create `backend/test/messaging-flow.e2e-spec.ts`:

```typescript
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionsService } from '../src/sessions/sessions.service';

describe('Messaging flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessionsService: SessionsService;
  let tableAId: number;
  let tableBId: number;
  let port: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    port = (app.getHttpServer().address() as any).port;

    prisma = app.get(PrismaService);
    sessionsService = app.get(SessionsService);

    const tableA = await prisma.table.create({
      data: { number: 9651, qrTokenSecret: 'secret-9651' },
    });
    const tableB = await prisma.table.create({
      data: { number: 9652, qrTokenSecret: 'secret-9652' },
    });
    tableAId = tableA.id;
    tableBId = tableB.id;
  });

  afterAll(async () => {
    await prisma.message.deleteMany({});
    await prisma.tableContact.deleteMany({ where: { OR: [{ tableAId }, { tableBId }] } });
    await prisma.clientSession.deleteMany({ where: { tableId: { in: [tableAId, tableBId] } } });
    await prisma.table.deleteMany({ where: { id: { in: [tableAId, tableBId] } } });
    await app.close();
  });

  function connect(token: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = io(`http://localhost:${port}`, { auth: { token } });
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
  }

  it('delivers a contact request and the queued message once accepted, over both REST and sockets', async () => {
    const { sessionToken: tokenA } = await sessionsService.createSession({
      tableId: tableAId,
      secret: 'secret-9651',
      pseudo: 'Alice',
    });
    const { sessionToken: tokenB } = await sessionsService.createSession({
      tableId: tableBId,
      secret: 'secret-9652',
      pseudo: 'Bob',
    });

    const socketB = await connect(tokenB);
    const contactRequestPromise = new Promise<any>((resolve) => {
      socketB.on('contact:request', resolve);
    });

    const sendRes = await request(app.getHttpServer())
      .post('/messages')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ toTableId: tableBId, kind: 'freetext', content: 'Salut !' })
      .expect(201);

    expect(sendRes.body.status).toBe('pending_approval');
    const contactId = sendRes.body.contactId;

    const requestPayload = await contactRequestPromise;
    expect(requestPayload.contactId).toBe(contactId);
    expect(requestPayload.fromTableId).toBe(tableAId);

    const socketA = await connect(tokenA);
    const messageNewPromise = new Promise<any>((resolve) => {
      socketA.on('message:new', resolve);
    });

    await request(app.getHttpServer())
      .post(`/contacts/${contactId}/respond`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ accept: true })
      .expect(201);

    const messagePayload = await messageNewPromise;
    expect(messagePayload.contactId).toBe(contactId);
    expect(messagePayload.message.content).toBe('Salut !');

    const historyRes = await request(app.getHttpServer())
      .get(`/contacts/${contactId}/messages`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    expect(historyRes.body).toHaveLength(1);
    expect(historyRes.body[0].content).toBe('Salut !');

    socketA.disconnect();
    socketB.disconnect();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd backend && npx jest --config ./test/jest-e2e.json messaging-flow.e2e-spec.ts`
Expected: PASS (1 test). If it fails, the failure points at an integration gap between tasks (e.g. an event payload shape mismatch) rather than at new logic — every piece it exercises was unit-tested in Tasks 3-5.

- [ ] **Step 3: Run the entire backend test suite**

Run: `cd backend && npx jest && npx jest --config ./test/jest-e2e.json`
Expected: every spec file from this plan and from Phase 1 passes, zero failures.

- [ ] **Step 4: Commit**

```bash
git add backend/test/messaging-flow.e2e-spec.ts
git commit -m "test: add end-to-end messaging flow smoke test"
```

---

## Definition of Done for this Plan

- `npx jest` (from `backend/`) passes with zero failures, including every Phase 1 suite (no regressions).
- `npx jest --config ./test/jest-e2e.json` (from `backend/`) passes with zero failures.
- A client can: fetch `GET /tables/occupied`, `POST /messages` to an unaccepted table (gets `pending_approval`), have the other table's connected socket receive `contact:request`, accept via `POST /contacts/:id/respond`, have the sender's socket receive `message:new` with the originally-queued content, and fetch the same message via `GET /contacts/:id/messages`.
- The mobile app (React Native, Expo Dev Client) consuming these endpoints is **out of scope** for this plan — it is the next plan in the Phase 2 sequence, written after this one is implemented so its REST/socket client code can be grounded in the real, running endpoints rather than assumptions.
