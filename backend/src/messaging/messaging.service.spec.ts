import { Test } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TablesService } from '../tables/tables.service';
import { MessagingService } from './messaging.service';

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
