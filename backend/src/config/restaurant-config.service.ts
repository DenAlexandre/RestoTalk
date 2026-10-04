import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { restaurantConfigSchema, RestaurantConfig } from './restaurant-config.schema';

@Injectable()
export class RestaurantConfigService {
  private readonly config: RestaurantConfig;

  constructor(
    filePath: string = process.env.RESTAURANT_CONFIG_PATH ?? 'config/restaurant.yaml',
  ) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = yaml.load(raw);
    const result = restaurantConfigSchema.safeParse(parsed);

    if (!result.success) {
      throw new Error(
        `Invalid restaurant config at ${filePath}: ${result.error.message}`,
      );
    }

    this.config = result.data.restaurant;
  }

  get(): RestaurantConfig {
    return this.config;
  }
}
