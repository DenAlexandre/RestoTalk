import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { RestaurantConfigService } from '../config/restaurant-config.service';
import { TablesService } from './tables.service';

@Injectable()
export class TableSeedService implements OnApplicationBootstrap {
  constructor(
    private readonly tablesService: TablesService,
    private readonly configService: RestaurantConfigService,
  ) {}

  async onApplicationBootstrap() {
    const { tableCount } = this.configService.get();
    await this.tablesService.ensureTablesSeeded(tableCount);
  }
}
