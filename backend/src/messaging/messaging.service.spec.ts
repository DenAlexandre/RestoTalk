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
