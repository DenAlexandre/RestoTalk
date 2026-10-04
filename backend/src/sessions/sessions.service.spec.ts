import { Test } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { JwtModule } from '@nestjs/jwt';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TablesService } from '../tables/tables.service';
import { SessionsService } from './sessions.service';

describe('SessionsService.createSession', () => {
  let prisma: PrismaService;
  let service: SessionsService;
  let tableId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        JwtModule.register({ secret: 'test-secret', signOptions: { expiresIn: '6h' } }),
      ],
      providers: [PrismaService, TablesService, SessionsService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(SessionsService);
    await prisma.onModuleInit();

    const table = await prisma.table.create({
      data: { number: 9101, qrTokenSecret: 'correct-secret' },
    });
    tableId = table.id;
  });

  afterAll(async () => {
    await prisma.clientSession.deleteMany({ where: { tableId } });
    await prisma.table.delete({ where: { id: tableId } });
    await prisma.onModuleDestroy();
  });

  it('creates a session and returns a signed token for a valid secret', async () => {
    const result = await service.createSession({
      tableId,
      secret: 'correct-secret',
      pseudo: 'Alice',
    });

    expect(result.session.pseudo).toBe('Alice');
    expect(result.session.status).toBe('active');
    expect(typeof result.sessionToken).toBe('string');
    expect(result.sessionToken.split('.')).toHaveLength(3);
  });

  it('rejects an unknown tableId', async () => {
    await expect(
      service.createSession({ tableId: 999999, secret: 'anything', pseudo: 'Bob' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a wrong secret of the same length', async () => {
    await expect(
      service.createSession({ tableId, secret: 'wrong-secret-x', pseudo: 'Eve' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a wrong secret of a different length', async () => {
    await expect(
      service.createSession({ tableId, secret: 'short', pseudo: 'Mallory' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('SessionsService.leaveSession', () => {
  let prisma: PrismaService;
  let service: SessionsService;
  let tableId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        JwtModule.register({ secret: 'test-secret' }),
      ],
      providers: [PrismaService, SessionsService, TablesService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(SessionsService);
    const table = await prisma.table.create({
      data: { number: 9202, qrTokenSecret: 'secret-9202', status: 'occupied' },
    });
    tableId = table.id;
  });

  afterAll(async () => {
    await prisma.clientSession.deleteMany({ where: { tableId } });
    await prisma.table.delete({ where: { id: tableId } });
    await prisma.onModuleDestroy();
  });

  it('marks the session left and frees the table when it was the last active one', async () => {
    const session = await prisma.clientSession.create({
      data: { tableId, pseudo: 'Alice', status: 'active' },
    });

    await service.leaveSession(session.id);

    const updatedSession = await prisma.clientSession.findUnique({ where: { id: session.id } });
    const table = await prisma.table.findUnique({ where: { id: tableId } });
    expect(updatedSession?.status).toBe('left');
    expect(updatedSession?.leftAt).not.toBeNull();
    expect(table?.status).toBe('free');
  });
});
