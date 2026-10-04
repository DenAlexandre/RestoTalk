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
