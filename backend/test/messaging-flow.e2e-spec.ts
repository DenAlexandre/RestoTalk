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
