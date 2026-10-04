import { Test } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { TablesService } from '../tables/tables.service';
import { SessionExpirationService } from './session-expiration.service';
import { RestaurantConfigService } from '../config/restaurant-config.service';

describe('SessionExpirationService.expireInactiveSessions', () => {
  let prisma: PrismaService;
  let service: SessionExpirationService;
  let eventEmitter: EventEmitter2;
  let tableId: number;

  beforeAll(async () => {
    const fakeConfig = { get: () => ({ sessionInactivityTimeoutHours: 4 }) };

    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        PrismaService,
        TablesService,
        SessionExpirationService,
        { provide: RestaurantConfigService, useValue: fakeConfig },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(SessionExpirationService);
    eventEmitter = moduleRef.get(EventEmitter2);
    await prisma.onModuleInit();

    const table = await prisma.table.create({
      data: { number: 9301, qrTokenSecret: 'secret-9301', status: 'occupied' },
    });
    tableId = table.id;
  });

  afterAll(async () => {
    await prisma.clientSession.deleteMany({ where: { tableId } });
    await prisma.table.delete({ where: { id: tableId } });
    await prisma.onModuleDestroy();
  });

  it('expires sessions inactive past the configured timeout and frees the table', async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const staleSession = await prisma.clientSession.create({
      data: { tableId, pseudo: 'Alice', status: 'active' },
    });
    await prisma.clientSession.update({
      where: { id: staleSession.id },
      data: { lastSeenAt: fiveHoursAgo },
    });

    const emitSpy = jest.spyOn(eventEmitter, 'emit');

    const expiredCount = await service.expireInactiveSessions();

    const updated = await prisma.clientSession.findUnique({ where: { id: staleSession.id } });
    const table = await prisma.table.findUnique({ where: { id: tableId } });
    expect(expiredCount).toBe(1);
    expect(updated?.status).toBe('expired');
    expect(table?.status).toBe('free');
    expect(emitSpy).toHaveBeenCalledWith('table.presence.changed', { tableId });

    emitSpy.mockRestore();
  });

  it('leaves a recently active session untouched', async () => {
    const freshSession = await prisma.clientSession.create({
      data: { tableId, pseudo: 'Bob', status: 'active' },
    });

    const emitSpy = jest.spyOn(eventEmitter, 'emit');

    await service.expireInactiveSessions();

    const unchanged = await prisma.clientSession.findUnique({ where: { id: freshSession.id } });
    expect(unchanged?.status).toBe('active');
    expect(emitSpy).not.toHaveBeenCalledWith('table.presence.changed', { tableId });

    emitSpy.mockRestore();
  });
});
