import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../sessions/session-auth.guard';
import { MessagingService } from './messaging.service';
import { SendMessageDto } from './dto/send-message.dto';

@UseGuards(SessionAuthGuard)
@Controller('messages')
export class MessagesController {
  constructor(private readonly messagingService: MessagingService) {}

  @Post()
  async send(@Req() req: any, @Body() dto: SendMessageDto) {
    return this.messagingService.sendMessage(req.session, dto);
  }
}
