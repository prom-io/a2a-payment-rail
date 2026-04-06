import { SkipThrottle } from '@nestjs/throttler';

export { SkipThrottle };

export const PublicEndpoint = () => SkipThrottle();
