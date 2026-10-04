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
