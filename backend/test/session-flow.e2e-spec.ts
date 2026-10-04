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
