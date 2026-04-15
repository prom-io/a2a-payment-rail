import { Injectable, NestMiddleware, ForbiddenException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_HEADER = 'x-csrf-token';
const CSRF_COOKIE = 'csrf-token';

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  private readonly secret: string;

  constructor() {
    this.secret = process.env.CSRF_SECRET ?? 'dev-csrf-secret-change-me';
  }

  use(req: Request, res: Response, next: NextFunction) {
    if (SAFE_METHODS.has(req.method)) {
      const token = this.issueToken();
      res.setHeader('Set-Cookie', `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict; HttpOnly`);
      res.setHeader('X-CSRF-Token', token);
      return next();
    }

    const headerToken = req.headers[CSRF_HEADER] as string | undefined;
    const cookieToken = this.extractCookie(req.headers.cookie ?? '', CSRF_COOKIE);

    if (!headerToken || !cookieToken) {
      throw new ForbiddenException('CSRF token missing');
    }

    if (!this.verifyToken(headerToken, cookieToken)) {
      throw new ForbiddenException('CSRF token mismatch');
    }

    next();
  }

  private issueToken(): string {
    const nonce = randomBytes(16).toString('hex');
    const signature = createHmac('sha256', this.secret).update(nonce).digest('hex');
    return `${nonce}.${signature}`;
  }

  private verifyToken(header: string, cookie: string): boolean {
    if (header !== cookie) return false;
    const [nonce, signature] = header.split('.');
    if (!nonce || !signature) return false;
    const expected = createHmac('sha256', this.secret).update(nonce).digest('hex');
    const a = Buffer.from(signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private extractCookie(cookieHeader: string, name: string): string | null {
    const parts = cookieHeader.split(';').map((c) => c.trim());
    for (const part of parts) {
      const [key, value] = part.split('=');
      if (key === name) return value;
    }
    return null;
  }
}
