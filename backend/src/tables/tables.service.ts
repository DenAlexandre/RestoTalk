import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { Table } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TablesService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: number): Promise<Table | null> {
    return this.prisma.table.findUnique({ where: { id } });
  }

  async ensureTablesSeeded(tableCount: number): Promise<void> {
    const existing = await this.prisma.table.findMany({
      where: { number: { lte: tableCount } },
      select: { number: true },
    });
    const existingNumbers = new Set(existing.map((t) => t.number));

    const missing = [];
    for (let number = 1; number <= tableCount; number++) {
      if (!existingNumbers.has(number)) {
        missing.push({
          number,
          qrTokenSecret: crypto.randomBytes(24).toString('hex'),
        });
      }
    }

    if (missing.length > 0) {
      await this.prisma.table.createMany({ data: missing });
    }
  }

  async refreshStatus(tableId: number): Promise<void> {
    const activeCount = await this.prisma.clientSession.count({
      where: { tableId, status: 'active' },
    });

    await this.prisma.table.update({
      where: { id: tableId },
      data: { status: activeCount > 0 ? 'occupied' : 'free' },
    });
  }

  async listOccupied(excludeTableId?: number) {
    const tables = await this.prisma.table.findMany({
      where: {
        status: 'occupied',
        ...(excludeTableId ? { id: { not: excludeTableId } } : {}),
      },
      include: {
        sessions: { where: { status: 'active' } },
      },
      orderBy: { number: 'asc' },
    });

    return tables.map((t) => ({
      tableId: t.id,
      number: t.number,
      activeSessionCount: t.sessions.length,
    }));
  }
}
