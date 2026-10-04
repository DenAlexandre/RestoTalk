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
