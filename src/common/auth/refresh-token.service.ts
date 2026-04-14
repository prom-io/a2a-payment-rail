import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { JwtPayload } from './jwt.strategy';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);
  private readonly revoked = new Set<string>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  issueTokenPair(payload: JwtPayload): TokenPair {
    const accessExpiresIn = this.configService.get<string>('JWT_EXPIRES_IN', '1h');
    const refreshExpiresIn = this.configService.get<string>('JWT_REFRESH_EXPIRES_IN', '7d');

    const accessToken = this.jwtService.sign(payload, { expiresIn: accessExpiresIn });
    const refreshToken = this.jwtService.sign(
      { ...payload, jti: randomBytes(16).toString('hex') },
      { expiresIn: refreshExpiresIn },
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: this.parseExpiresIn(accessExpiresIn),
    };
  }

  async rotate(refreshToken: string): Promise<TokenPair> {
    const tokenHash = this.hashToken(refreshToken);
    if (this.revoked.has(tokenHash)) {
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    try {
      const payload = this.jwtService.verify<JwtPayload & { jti: string }>(refreshToken);
      this.revoke(refreshToken);
      return this.issueTokenPair({
        sub: payload.sub,
        address: payload.address,
        role: payload.role,
      });
    } catch (error) {
      this.logger.warn(`Refresh token rotation failed: ${(error as Error).message}`);
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  revoke(refreshToken: string): void {
    this.revoked.add(this.hashToken(refreshToken));
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private parseExpiresIn(value: string): number {
    const match = value.match(/^(\d+)([smhd])$/);
    if (!match) return 3600;
    const n = parseInt(match[1], 10);
    const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    return n * (units[match[2]] ?? 1);
  }
}
