import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { PaymentReceipt } from './entities/payment-receipt.entity';
import { CreateReceiptDto } from './dto/create-receipt.dto';
import { ValidateReceiptDto } from './dto/validate-receipt.dto';

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

  async markSettled(receiptIds: string[], settlementId: string): Promise<void> {
    if (receiptIds.length === 0) return;
    await this.receiptRepo.update({ id: In(receiptIds) }, { settlementId });
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
