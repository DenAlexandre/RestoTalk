import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionAuthGuard } from './session-auth.guard';

function contextWithAuthHeader(header?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: header } }),
    }),
  } as unknown as ExecutionContext;
}

describe('SessionAuthGuard', () => {
  let prisma: PrismaService;
  let jwtService: JwtService;
  let guard: SessionAuthGuard;
  let tableId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'test-secret' })],
      providers: [PrismaService, SessionAuthGuard],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    jwtService = moduleRef.get(JwtService);
    guard = moduleRef.get(SessionAuthGuard);
    await prisma.onModuleInit();

    const table = await prisma.table.create({
      data: { number: 9102, qrTokenSecret: 'secret-9102' },
    });
    tableId = table.id;
  });

  afterAll(async () => {
    await prisma.clientSession.deleteMany({ where: { tableId } });
    await prisma.table.delete({ where: { id: tableId } });
    await prisma.onModuleDestroy();
  });

  it('allows a valid token for an active session', async () => {
    const session = await prisma.clientSession.create({
      data: { tableId, pseudo: 'Alice', status: 'active' },
    });
    const token = jwtService.sign({ sub: session.id, tableId });

    const context = contextWithAuthHeader(`Bearer ${token}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rejects a well-formed token for a session marked expired in the DB', async () => {
    const session = await prisma.clientSession.create({
      data: { tableId, pseudo: 'Bob', status: 'expired' },
    });
    const token = jwtService.sign({ sub: session.id, tableId });

    const context = contextWithAuthHeader(`Bearer ${token}`);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a missing Authorization header', async () => {
    const context = contextWithAuthHeader(undefined);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a malformed token', async () => {
    const context = contextWithAuthHeader('Bearer not-a-real-token');
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
