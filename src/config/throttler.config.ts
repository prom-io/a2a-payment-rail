import { ConfigService } from '@nestjs/config';
import { ThrottlerModuleOptions } from '@nestjs/throttler';

export const throttlerConfigFactory = (
  configService: ConfigService,
): ThrottlerModuleOptions => ({
  throttlers: [
    {
      name: 'short',
      ttl: configService.get<number>('THROTTLE_SHORT_TTL', 1000),
      limit: configService.get<number>('THROTTLE_SHORT_LIMIT', 10),
    },
    {
      name: 'long',
      ttl: configService.get<number>('THROTTLE_LONG_TTL', 60000),
      limit: configService.get<number>('THROTTLE_LONG_LIMIT', 100),
    },
  ],
});
