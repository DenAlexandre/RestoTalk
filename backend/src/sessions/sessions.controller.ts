import { Body, Controller, Post } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { CreateSessionDto } from './dto/create-session.dto';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Post()
  async create(@Body() dto: CreateSessionDto) {
    const { sessionToken, session } = await this.sessionsService.createSession(dto);
    return {
      sessionToken,
      session: { id: session.id, pseudo: session.pseudo, tableId: session.tableId },
    };
  }
}
