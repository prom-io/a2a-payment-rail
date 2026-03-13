import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Settlement, SettlementStatus } from './entities/settlement.entity';
import { SettleBatchDto } from './dto/settle-batch.dto';

@Injectable()
export class SettlementService {
  constructor(
    @InjectRepository(Settlement)
    private readonly settlementRepo: Repository<Settlement>,
  ) {}

  async settleBatch(dto: SettleBatchDto): Promise<Settlement> {
    const settlement = this.settlementRepo.create({
      escrowId: dto.escrowId,
      receiptsHash: dto.receiptsHash,
      totalAmount: dto.totalAmount.toString(),
      status: SettlementStatus.PENDING,
    });
    return this.settlementRepo.save(settlement);
  }

  async findById(id: string): Promise<Settlement> {
    const settlement = await this.settlementRepo.findOne({ where: { id } });
    if (!settlement) throw new NotFoundException(`Settlement ${id} not found`);
    return settlement;
  }

  async findByEscrowId(escrowId: string): Promise<Settlement[]> {
    return this.settlementRepo.find({ where: { escrowId } });
  }
}
