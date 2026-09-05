import { SkipThrottle } from '@nestjs/throttler';

/**
 * Троттлеры в приложении именованные (см. throttler.config.ts), а голый
 * SkipThrottle() снимает только безымянный default. Из-за этого помеченный
 * эндпоинт всё равно упирался в лимит и отвечал 429. Имена перечисляем явно,
 * чтобы исключение действительно работало.
 */
export const THROTTLERS = { short: true, long: true } as const;

/** Снимает ВСЕ лимиты с эндпоинта. Использовать вместо голого SkipThrottle(). */
export const SkipAllThrottles = () => SkipThrottle(THROTTLERS);

export { SkipThrottle };

export const PublicEndpoint = () => SkipThrottle(THROTTLERS);
