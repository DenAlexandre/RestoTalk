import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RealtimeGateway } from './realtime.gateway';
import { TablesModule } from '../tables/tables.module';

@Module({
  imports: [
    TablesModule,
    JwtModule.register({ secret: process.env.JWT_SECRET }),
  ],
  providers: [RealtimeGateway],
})
export class RealtimeModule {}
