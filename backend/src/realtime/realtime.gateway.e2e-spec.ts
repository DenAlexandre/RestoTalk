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
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
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
    await prisma.clientSession.deleteMany({
      where: { tableId: { in: [tableAId, tableBId] } },
    });
    await prisma.table.deleteMany({
      where: { id: { in: [tableAId, tableBId] } },
    });
    await app.close();
  });

  function connect(token: string): Promise<Socket> {
    const address = app.getHttpServer().address();
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
    const address = app.getHttpServer().address();
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
