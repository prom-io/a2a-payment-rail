import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { ethers } from 'ethers';
import { Settlement, SettlementStatus } from './entities/settlement.entity';
import { SettleBatchDto } from './dto/settle-batch.dto';
import { BlockchainService } from '../../common/blockchain/blockchain.service';
import { ESCROW_HUB_ABI } from '../../common/blockchain/abis/escrow-hub.abi';

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);
  private readonly escrowHubAddress: string;

  constructor(
    @InjectRepository(Settlement)
    private readonly settlementRepo: Repository<Settlement>,
    private readonly blockchainService: BlockchainService,
    private readonly configService: ConfigService,
  ) {
    this.escrowHubAddress = this.configService.get<string>('ESCROW_HUB_ADDRESS', '');
  }

  async settleBatch(dto: SettleBatchDto): Promise<Settlement & { txHash?: string }> {
    const settlement = this.settlementRepo.create({
      escrowId: dto.escrowId,
      receiptsHash: dto.receiptsHash,
      totalAmount: dto.totalAmount.toString(),
      status: SettlementStatus.PENDING,
    });
    const saved = await this.settlementRepo.save(settlement);

    let txHash: string | undefined;
    if (this.escrowHubAddress) {
      try {
        const contract = this.blockchainService.getContract(this.escrowHubAddress, ESCROW_HUB_ABI);
        const escrowIdHash = ethers.keccak256(ethers.toUtf8Bytes(dto.escrowId));
        const receiptsHashBytes = ethers.keccak256(ethers.toUtf8Bytes(dto.receiptsHash));
        const amountWei = ethers.parseEther(dto.totalAmount.toString());
        const tx = await contract.settleBatch(escrowIdHash, receiptsHashBytes, amountWei);
        const receipt = await tx.wait();
        txHash = receipt.hash;
        saved.status = SettlementStatus.SETTLED;
        saved.settledAt = new Date();
        await this.settlementRepo.save(saved);
        this.logger.log(`Settlement batch for escrow ${dto.escrowId} completed, tx: ${txHash}`);
      } catch (error: any) {
        saved.status = SettlementStatus.REJECTED;
        await this.settlementRepo.save(saved);
        this.logger.error(`On-chain settlement failed: ${error.message}`);
      }
    }

    return { ...saved, txHash };
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
