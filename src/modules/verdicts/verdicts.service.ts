import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface VerdictStatus {
  sessionId: string;
  outcome: string;
  payableAmount: number;
}

@Injectable()
export class VerdictsService {
  private readonly verificationNetworkUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.verificationNetworkUrl = this.configService.get<string>(
      'VERIFICATION_NETWORK_URL',
      'http://localhost:3002',
    );
  }

  async getStatus(sessionId: string): Promise<VerdictStatus> {
    try {
      const response = await fetch(
        `${this.verificationNetworkUrl}/verdicts/${sessionId}`,
      );
      if (!response.ok) {
        throw new HttpException(
          `Verdict not found for session ${sessionId}`,
          HttpStatus.NOT_FOUND,
        );
      }
      return (await response.json()) as VerdictStatus;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        'Verification network unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  async release(sessionId: string): Promise<{ released: boolean }> {
    try {
      const response = await fetch(
        `${this.verificationNetworkUrl}/verdicts/${sessionId}/release`,
        { method: 'POST' },
      );
      if (!response.ok) {
        throw new HttpException(
          'Release failed',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      return { released: true };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        'Verification network unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
