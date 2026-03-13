import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StreamClaim } from './entities/stream-claim.entity';
import { ClaimStreamDto } from './dto/claim-stream.dto';

@Injectable()
export class StreamingService {
  constructor(
    @InjectRepository(StreamClaim)
    private readonly claimRepo: Repository<StreamClaim>,
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
}
