import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StreamClaim } from './entities/stream-claim.entity';
import { ClaimStreamDto } from './dto/claim-stream.dto';
import { RefundResult } from './dto/refund-stream.dto';
import { EscrowService } from '../escrow/escrow.service';
import { EscrowStatus } from '../escrow/entities/escrow-session.entity';

@Injectable()
export class StreamingService {
  private readonly logger = new Logger(StreamingService.name);

  constructor(
    @InjectRepository(StreamClaim)
    private readonly claimRepo: Repository<StreamClaim>,
    private readonly escrowService: EscrowService,
  ) {}

  async claim(dto: ClaimStreamDto): Promise<StreamClaim> {
    const lastClaim = await this.claimRepo.findOne({
      where: { escrowId: dto.escrowId },
      order: { claimedAt: 'DESC' },
    });

    const previousCumulative = lastClaim
      ? parseFloat(lastClaim.cumulativeAmount)
      : 0;

    const claim = this.claimRepo.create({
      escrowId: dto.escrowId,
      usageDelta: dto.usageDelta.toString(),
      cumulativeAmount: (previousCumulative + dto.usageDelta).toString(),
    });
    return this.claimRepo.save(claim);
  }

  async findByEscrowId(escrowId: string): Promise<StreamClaim[]> {
    return this.claimRepo.find({
      where: { escrowId },
      order: { claimedAt: 'ASC' },
    });
  }

  async refundUnused(escrowId: string, reason?: string): Promise<RefundResult> {
    const session = await this.escrowService.findById(escrowId);

    if (session.status === EscrowStatus.CLOSED) {
      throw new BadRequestException(
        `Escrow ${escrowId} is already closed; refund must be issued before close`,
      );
    }

    const claims = await this.findByEscrowId(escrowId);
    const totalClaimed = claims.reduce(
      (acc, c) => acc + Number(c.usageDelta),
      0,
    );
    const totalDeposited = Number(session.depositAmount);

    if (totalClaimed > totalDeposited) {
      this.logger.warn(
        `Refund requested but claims (${totalClaimed}) exceed deposit (${totalDeposited}) for escrow ${escrowId}`,
      );
    }

    const refundAmount = Math.max(totalDeposited - totalClaimed, 0);

    await this.escrowService.emergencyClose(escrowId);

    const result: RefundResult = {
      escrowId,
      totalDeposited: totalDeposited.toString(),
      totalClaimed: totalClaimed.toString(),
      refundAmount: refundAmount.toString(),
      refundedAt: new Date().toISOString(),
      reason,
    };

    this.logger.log(
      `Refund issued for escrow ${escrowId}: ${refundAmount} (claimed ${totalClaimed} of ${totalDeposited})${reason ? `, reason: ${reason}` : ''}`,
    );

    return result;
  }
}
