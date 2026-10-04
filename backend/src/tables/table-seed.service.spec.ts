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
