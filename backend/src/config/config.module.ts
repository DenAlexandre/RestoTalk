import { Global, Module } from '@nestjs/common';
import { RestaurantConfigService } from './restaurant-config.service';

@Global()
@Module({
  providers: [
    {
      provide: RestaurantConfigService,
      useFactory: () => new RestaurantConfigService(),
    },
  ],
  exports: [RestaurantConfigService],
})
export class ConfigModule {}
