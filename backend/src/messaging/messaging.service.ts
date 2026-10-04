import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClientSession, Message, TableContact } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TablesService } from '../tables/tables.service';
import { SendMessageDto } from './dto/send-message.dto';

@Injectable()
export class MessagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tablesService: TablesService,
    private readonly events: EventEmitter2,
  ) {}

  private async findLiveContact(tableAId: number, tableBId: number) {
    return this.prisma.tableContact.findFirst({
      where: {
        status: { in: ['pending', 'accepted'] },
        OR: [
          { tableAId, tableBId },
          { tableAId: tableBId, tableBId: tableAId },
        ],
      },
    });
  }

  async sendMessage(
    session: ClientSession,
    dto: SendMessageDto,
  ): Promise<{ status: 'sent' | 'pending_approval'; contactId: number; message?: Message }> {
    if (dto.toTableId === session.tableId) {
      throw new BadRequestException('Cannot message your own table');
    }

    const targetTable = await this.tablesService.findById(dto.toTableId);
    if (!targetTable) {
      throw new NotFoundException('Unknown table');
    }
    if (targetTable.status !== 'occupied') {
      throw new BadRequestException('Target table is not occupied');
    }

    let contact = await this.findLiveContact(session.tableId, dto.toTableId);
    let isNewContact = false;

    if (!contact) {
      contact = await this.prisma.tableContact.create({
        data: {
          tableAId: session.tableId,
          tableBId: dto.toTableId,
          requestedBySessionId: session.id,
        },
      });
      isNewContact = true;
    }

    const message = await this.prisma.message.create({
      data: {
        contactId: contact.id,
        senderSessionId: session.id,
        kind: dto.kind,
        predefinedCode: dto.predefinedCode ?? null,
        content: dto.content,
      },
    });

    if (contact.status === 'accepted') {
      this.events.emit('message.new', {
        contactId: contact.id,
        toTableId: dto.toTableId,
        message: {
          id: message.id,
          kind: message.kind,
          predefinedCode: message.predefinedCode,
          content: message.content,
          senderSessionId: message.senderSessionId,
          createdAt: message.createdAt,
        },
      });
      this.events.emit('message.new', {
        contactId: contact.id,
        toTableId: session.tableId,
        message: {
          id: message.id,
          kind: message.kind,
          predefinedCode: message.predefinedCode,
          content: message.content,
          senderSessionId: message.senderSessionId,
          createdAt: message.createdAt,
        },
      });
      return { status: 'sent', contactId: contact.id, message };
    }

    if (isNewContact) {
      this.events.emit('contact.request', {
        contactId: contact.id,
        toTableId: dto.toTableId,
        fromTableId: session.tableId,
        fromTableNumber: (await this.tablesService.findById(session.tableId))?.number,
      });
    }

    return { status: 'pending_approval', contactId: contact.id };
  }

  async respondToContact(
    session: ClientSession,
    contactId: number,
    accept: boolean,
  ): Promise<TableContact> {
    const contact = await this.prisma.tableContact.findUnique({ where: { id: contactId } });

    if (!contact) {
      throw new NotFoundException('Unknown contact');
    }

    if (contact.tableBId !== session.tableId) {
      throw new ForbiddenException('Only the destination table can respond to this contact');
    }

    if (contact.status !== 'pending') {
      throw new BadRequestException('Contact is already resolved');
    }

    const updated = await this.prisma.tableContact.update({
      where: { id: contactId },
      data: { status: accept ? 'accepted' : 'refused', respondedAt: new Date() },
    });

    this.events.emit('contact.resolved', {
      contactId,
      toTableId: contact.tableAId,
      status: updated.status,
    });

    if (accept) {
      const messages = await this.prisma.message.findMany({ where: { contactId } });
      for (const message of messages) {
        const payload = {
          id: message.id,
          kind: message.kind,
          predefinedCode: message.predefinedCode,
          content: message.content,
          senderSessionId: message.senderSessionId,
          createdAt: message.createdAt,
        };
        this.events.emit('message.new', { contactId, toTableId: contact.tableAId, message: payload });
        this.events.emit('message.new', { contactId, toTableId: contact.tableBId, message: payload });
      }
    }

    return updated;
  }

  async getMessages(session: ClientSession, contactId: number): Promise<Message[]> {
    const contact = await this.prisma.tableContact.findUnique({ where: { id: contactId } });

    if (!contact) {
      throw new NotFoundException('Unknown contact');
    }

    if (contact.tableAId !== session.tableId && contact.tableBId !== session.tableId) {
      throw new ForbiddenException('Not a participant of this contact');
    }

    if (contact.status !== 'accepted') {
      throw new BadRequestException('Contact is not accepted');
    }

    return this.prisma.message.findMany({
      where: { contactId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
