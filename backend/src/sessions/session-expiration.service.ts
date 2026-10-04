import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { TablesService } from '../tables/tables.service';
import { RestaurantConfigService } from '../config/restaurant-config.service';

@Injectable()
export class SessionExpirationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tablesService: TablesService,
    private readonly configService: RestaurantConfigService,
    private readonly events: EventEmitter2,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron() {
    await this.expireInactiveSessions();
  }

  async expireInactiveSessions(): Promise<number> {
    const { sessionInactivityTimeoutHours } = this.configService.get();
    const cutoff = new Date(Date.now() - sessionInactivityTimeoutHours * 60 * 60 * 1000);

    const stale = await this.prisma.clientSession.findMany({
      where: { status: 'active', lastSeenAt: { lt: cutoff } },
    });

    for (const session of stale) {
      await this.prisma.clientSession.update({
        where: { id: session.id },
        data: { status: 'expired' },
      });
      await this.tablesService.refreshStatus(session.tableId);
      this.events.emit('table.presence.changed', { tableId: session.tableId });
    }

    return stale.length;
  }
}
