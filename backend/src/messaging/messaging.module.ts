import { Module } from '@nestjs/common';
import { TablesModule } from '../tables/tables.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TablesDirectoryController } from './tables-directory.controller';
import { MessagesController } from './messages.controller';
import { MessagingService } from './messaging.service';

@Module({
  imports: [TablesModule, SessionsModule],
  controllers: [TablesDirectoryController, MessagesController],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
