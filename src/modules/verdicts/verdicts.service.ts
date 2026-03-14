import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface VerdictStatus {
  sessionId: string;
  outcome: string;
  payableAmount: string;
  metaHash: string;
}

@Injectable()
export class VerdictsService {
  private readonly logger = new Logger(VerdictsService.name);
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
      this.logger.error(`Verification network unavailable: ${error}`);
      throw new HttpException('Verification network unavailable', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async release(sessionId: string): Promise<{ released: boolean; verdict?: VerdictStatus }> {
    const verdict = await this.getStatus(sessionId);
    if (verdict.outcome === 'accept') {
      this.logger.log(`Funds released for session ${sessionId}, amount: ${verdict.payableAmount}`);
      return { released: true, verdict };
    } else if (verdict.outcome === 'partial') {
      this.logger.log(`Partial release for session ${sessionId}, amount: ${verdict.payableAmount}`);
      return { released: true, verdict };
    } else {
      this.logger.warn(`Release rejected for session ${sessionId}`);
      return { released: false, verdict };
    }
  }
}
