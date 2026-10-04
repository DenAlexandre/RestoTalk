import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { SessionAuthGuard } from './session-auth.guard';
import { TablesModule } from '../tables/tables.module';

@Module({
  imports: [
    TablesModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '6h' },
    }),
  ],
  controllers: [SessionsController],
  providers: [SessionsService, SessionAuthGuard],
  exports: [SessionsService],
})
export class SessionsModule {}
