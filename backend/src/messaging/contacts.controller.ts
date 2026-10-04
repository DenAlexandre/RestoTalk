import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../sessions/session-auth.guard';
import { MessagingService } from './messaging.service';
import { RespondContactDto } from './dto/respond-contact.dto';

@UseGuards(SessionAuthGuard)
@Controller('contacts')
export class ContactsController {
  constructor(private readonly messagingService: MessagingService) {}

  @Post(':contactId/respond')
  async respond(
    @Req() req: any,
    @Param('contactId', ParseIntPipe) contactId: number,
    @Body() dto: RespondContactDto,
  ) {
    const updated = await this.messagingService.respondToContact(req.session, contactId, dto.accept);
    return { status: updated.status };
  }

  @Get(':contactId/messages')
  async messages(@Req() req: any, @Param('contactId', ParseIntPipe) contactId: number) {
    return this.messagingService.getMessages(req.session, contactId);
  }
}
