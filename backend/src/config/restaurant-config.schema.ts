import { z } from 'zod';

export const restaurantConfigSchema = z.object({
  restaurant: z.object({
    name: z.string().min(1),
    tableCount: z.number().int().positive(),
    sessionInactivityTimeoutHours: z.number().positive(),
  }),
});

export type RestaurantConfig = z.infer<typeof restaurantConfigSchema>['restaurant'];
