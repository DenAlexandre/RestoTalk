import { Module } from '@nestjs/common';
import { TablesService } from './tables.service';
import { TableSeedService } from './table-seed.service';

@Module({
  providers: [TablesService, TableSeedService],
  exports: [TablesService],
})
export class TablesModule {}
