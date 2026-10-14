import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { PaymentReceipt } from './entities/payment-receipt.entity';
import { CreateReceiptDto } from './dto/create-receipt.dto';
import { ValidateReceiptDto } from './dto/validate-receipt.dto';
import { merkleProof, merkleRoot } from './merkle.util';

export interface InclusionProof {
  receiptHash: string;
  settlementId: string;
  /** Leaf index of the receipt inside the batch. */
  index: number;
  leafCount: number;
  /** Equals settlement.receiptsHash of the batch. */
  root: string;
  proof: string[];
}

@Injectable()
export class ReceiptsService {
  constructor(
    @InjectRepository(PaymentReceipt)
    private readonly receiptRepo: Repository<PaymentReceipt>,
  ) {}

  async create(dto: CreateReceiptDto): Promise<PaymentReceipt> {
    const receipt = this.receiptRepo.create({
      escrowId: dto.escrowId,
      sessionId: dto.sessionId,
      fromAgent: dto.fromAgent,
      toAgent: dto.toAgent,
      amount: dto.amount.toString(),
      receiptHash: dto.receiptHash,
      signature: dto.signature,
    });
    return this.receiptRepo.save(receipt);
  }

  async findByEscrowId(escrowId: string): Promise<PaymentReceipt[]> {
    return this.receiptRepo.find({
      where: { escrowId },
      order: { createdAt: 'ASC' },
    });
  }

  async findByEscrowIds(escrowIds: string[]): Promise<Record<string, PaymentReceipt[]>> {
    if (escrowIds.length === 0) return {};
    const rows = await this.receiptRepo.find({
      where: { escrowId: In(escrowIds) },
      order: { createdAt: 'ASC' },
    });
    return rows.reduce<Record<string, PaymentReceipt[]>>((acc, row) => {
      if (!acc[row.escrowId]) acc[row.escrowId] = [];
      acc[row.escrowId].push(row);
      return acc;
    }, {});
  }

  /** Oldest receipts that are not part of any settlement batch yet. */
  async findUnsettled(limit: number): Promise<PaymentReceipt[]> {
    return this.receiptRepo.find({
      where: { settlementId: IsNull() },
      order: { createdAt: 'ASC', id: 'ASC' },
      take: limit,
    });
  }

  /**
   * Attaches receipts to their settlement. The order of `receiptIds` is the
   * leaf order of the batch and is stored, so a proof can be rebuilt later.
   */
  async markSettled(receiptIds: string[], settlementId: string): Promise<void> {
    if (receiptIds.length === 0) return;
    await this.receiptRepo.manager.transaction(async (manager) => {
      for (const [batchIndex, id] of receiptIds.entries()) {
        await manager.update(PaymentReceipt, { id }, { settlementId, batchIndex });
      }
    });
  }

  /** Merkle proof that a receipt is part of the batch it was settled in. */
  async inclusionProof(receiptHash: string): Promise<InclusionProof> {
    const receipt = await this.receiptRepo.findOne({ where: { receiptHash } });
    if (!receipt) throw new NotFoundException(`Receipt ${receiptHash} not found`);
    if (!receipt.settlementId) {
      throw new ConflictException(`Receipt ${receiptHash} is not part of a settlement batch yet`);
    }

    const batch = await this.receiptRepo.find({
      where: { settlementId: receipt.settlementId },
      // createdAt/id only decide the order of batches written before batchIndex existed
      order: { batchIndex: 'ASC', createdAt: 'ASC', id: 'ASC' },
    });
    const leaves = batch.map((row) => row.receiptHash);
    const index = batch.findIndex((row) => row.id === receipt.id);

    return {
      receiptHash: receipt.receiptHash,
      settlementId: receipt.settlementId,
      index,
      leafCount: leaves.length,
      root: merkleRoot(leaves),
      proof: merkleProof(leaves, index),
    };
  }

  async validate(
    dto: ValidateReceiptDto,
  ): Promise<{ valid: boolean; message: string }> {
    const receipt = await this.receiptRepo.findOne({
      where: { receiptHash: dto.receiptHash },
    });
    if (!receipt) {
      return { valid: false, message: 'Receipt not found' };
    }
    const signatureMatch = receipt.signature === dto.signature;
    return {
      valid: signatureMatch,
      message: signatureMatch ? 'Valid receipt' : 'Signature mismatch',
    };
  }
}
