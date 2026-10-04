import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { SessionAuthGuard } from './session-auth.guard';

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

  @UseGuards(SessionAuthGuard)
  @Get('me')
  async me(@Req() req: any) {
    const updated = await this.sessionsService.touchLastSeen(req.session.id);
    return {
      id: updated.id,
      pseudo: updated.pseudo,
      tableId: updated.tableId,
      status: updated.status,
    };
  }

  @UseGuards(SessionAuthGuard)
  @Post(':id/leave')
  async leave(@Req() req: any) {
    await this.sessionsService.leaveSession(req.session.id);
    return { status: 'left' };
  }
}
