import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../sessions/session-auth.guard';
import { TablesService } from '../tables/tables.service';

@UseGuards(SessionAuthGuard)
@Controller('tables')
export class TablesDirectoryController {
  constructor(private readonly tablesService: TablesService) {}

  @Get('occupied')
  async occupied(@Req() req: any) {
    return this.tablesService.listOccupied(req.session.tableId);
  }
}
