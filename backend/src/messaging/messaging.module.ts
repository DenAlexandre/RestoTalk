import { Module } from '@nestjs/common';
import { TablesModule } from '../tables/tables.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TablesDirectoryController } from './tables-directory.controller';

@Module({
  imports: [TablesModule, SessionsModule],
  controllers: [TablesDirectoryController],
})
export class MessagingModule {}
