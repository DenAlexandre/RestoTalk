import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import { ClientSession } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TablesService } from '../tables/tables.service';
import { CreateSessionDto } from './dto/create-session.dto';

function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tablesService: TablesService,
    private readonly jwtService: JwtService,
    private readonly events: EventEmitter2,
  ) {}

  async createSession(
    dto: CreateSessionDto,
  ): Promise<{ sessionToken: string; session: ClientSession }> {
    const table = await this.tablesService.findById(dto.tableId);
    if (!table) {
      throw new NotFoundException('Unknown table');
    }

    if (!secretsMatch(dto.secret, table.qrTokenSecret)) {
      throw new UnauthorizedException('Invalid QR secret');
    }

    const session = await this.prisma.clientSession.create({
      data: { tableId: table.id, pseudo: dto.pseudo },
    });

    await this.prisma.table.update({
      where: { id: table.id },
      data: { status: 'occupied' },
    });

    const sessionToken = this.jwtService.sign({ sub: session.id, tableId: table.id });

    this.events.emit('table.presence.changed', { tableId: table.id });

    return { sessionToken, session };
  }

  async touchLastSeen(sessionId: number) {
    return this.prisma.clientSession.update({
      where: { id: sessionId },
      data: { lastSeenAt: new Date() },
    });
  }
}
