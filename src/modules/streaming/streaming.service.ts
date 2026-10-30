import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StreamClaim } from './entities/stream-claim.entity';
import { ClaimStreamDto } from './dto/claim-stream.dto';
import { RefundResult } from './dto/refund-stream.dto';
import { EscrowService } from '../escrow/escrow.service';
import { EscrowStatus } from '../escrow/entities/escrow-session.entity';
import { Amount } from '../../common/money/amount';

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

    const usageDelta = Amount.from(dto.usageDelta);
    const previousCumulative = lastClaim ? Amount.from(lastClaim.cumulativeAmount) : Amount.ZERO;

    const claim = this.claimRepo.create({
      escrowId: dto.escrowId,
      usageDelta: usageDelta.toPlain(),
      cumulativeAmount: previousCumulative.plus(usageDelta).toPlain(),
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
    const totalClaimed = Amount.sum(claims.map((c) => c.usageDelta));
    const totalDeposited = Amount.from(session.depositAmount);

    if (totalClaimed.gt(totalDeposited)) {
      this.logger.warn(
        `Refund requested but claims (${totalClaimed.toPlain()}) exceed deposit (${totalDeposited.toPlain()}) for escrow ${escrowId}`,
      );
    }

    const refundAmount = totalDeposited.minusFloored(totalClaimed);

    await this.escrowService.emergencyClose(escrowId);

    const result: RefundResult = {
      escrowId,
      // toPlain keeps the shape these fields always had ("1", "0.5"), now without float noise
      totalDeposited: totalDeposited.toPlain(),
      totalClaimed: totalClaimed.toPlain(),
      refundAmount: refundAmount.toPlain(),
      refundedAt: new Date().toISOString(),
      reason,
    };

    this.logger.log(
      `Refund issued for escrow ${escrowId}: ${refundAmount.toPlain()} (claimed ${totalClaimed.toPlain()} of ${totalDeposited.toPlain()})${reason ? `, reason: ${reason}` : ''}`,
    );

    return result;
  }
}
