import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { ethers } from 'ethers';
import { EscrowSession, EscrowStatus } from './entities/escrow-session.entity';
import { OpenEscrowDto } from './dto/open-escrow.dto';
import { BlockchainService } from '../../common/blockchain/blockchain.service';
import { ESCROW_HUB_ABI } from '../../common/blockchain/abis/escrow-hub.abi';
import { WebhookEvent } from '../webhooks/webhook-events';
import { WebhooksService } from '../webhooks/webhooks.service';

@Injectable()
export class EscrowService {
  private readonly logger = new Logger(EscrowService.name);
  private readonly escrowHubAddress: string;

  constructor(
    @InjectRepository(EscrowSession)
    private readonly escrowRepo: Repository<EscrowSession>,
    private readonly blockchainService: BlockchainService,
    private readonly configService: ConfigService,
    private readonly webhooksService: WebhooksService,
  ) {
    this.escrowHubAddress = this.configService.get<string>('ESCROW_HUB_ADDRESS', '');
  }

  async open(dto: OpenEscrowDto): Promise<EscrowSession & { escrowIdHash?: string; txHash?: string }> {
    const session = this.escrowRepo.create({
      agentA: dto.agentA,
      agentB: dto.agentB,
      depositAmount: dto.depositAmount.toString(),
      budgetLimit: dto.budgetLimit.toString(),
      policyFlags: dto.policyFlags ?? {},
      verificationRequired: dto.verificationRequired ?? false,
      ttl: dto.ttl,
      status: EscrowStatus.OPEN,
    });
    const saved = await this.escrowRepo.save(session);

    let txHash: string | undefined;
    const escrowIdHash = ethers.keccak256(ethers.toUtf8Bytes(saved.id));

    if (this.escrowHubAddress) {
      try {
        const contract = this.blockchainService.getContract(this.escrowHubAddress, ESCROW_HUB_ABI);
        const depositWei = ethers.parseEther(dto.depositAmount.toString());
        const budgetWei = ethers.parseEther(dto.budgetLimit.toString());
        const tx = await contract.openEscrow(
          escrowIdHash,
          dto.agentB,
          budgetWei,
          dto.verificationRequired ?? false,
          dto.ttl,
          { value: depositWei },
        );
        const receipt = await tx.wait();
        txHash = receipt.hash;
        this.logger.log(`Escrow ${saved.id} opened on-chain, tx: ${txHash}`);
      } catch (error: any) {
        this.logger.error(`On-chain escrow open failed: ${error.message}`);
      }
    }

    void this.webhooksService.emit(WebhookEvent.ESCROW_OPENED, {
      escrowId: saved.id,
      agentA: saved.agentA,
      agentB: saved.agentB,
      depositAmount: saved.depositAmount,
      budgetLimit: saved.budgetLimit,
      ttl: saved.ttl,
      txHash: txHash ?? null,
    });
    return { ...saved, escrowIdHash, txHash };
  }

  async findById(id: string): Promise<EscrowSession> {
    const session = await this.escrowRepo.findOne({ where: { id } });
    if (!session) throw new NotFoundException(`Escrow ${id} not found`);
    return session;
  }

  async close(id: string): Promise<EscrowSession & { txHash?: string }> {
    const session = await this.findById(id);
    session.status = EscrowStatus.CLOSED;
    session.closedAt = new Date();
    const saved = await this.escrowRepo.save(session);

    let txHash: string | undefined;
    if (this.escrowHubAddress) {
      try {
        const escrowIdHash = ethers.keccak256(ethers.toUtf8Bytes(id));
        const contract = this.blockchainService.getContract(this.escrowHubAddress, ESCROW_HUB_ABI);
        const tx = await contract.closeEscrow(escrowIdHash);
        const receipt = await tx.wait();
        txHash = receipt.hash;
        this.logger.log(`Escrow ${id} closed on-chain, tx: ${txHash}`);
      } catch (error: any) {
        this.logger.error(`On-chain escrow close failed: ${error.message}`);
      }
    }

    this.emitClosed(saved, 'closed', txHash);
    return { ...saved, txHash };
  }

  async emergencyClose(id: string): Promise<EscrowSession> {
    const session = await this.findById(id);
    session.status = EscrowStatus.CLOSED;
    session.closedAt = new Date();
    const saved = await this.escrowRepo.save(session);
    this.emitClosed(saved, 'emergency');
    return saved;
  }

  // Fire and forget: emit() never rejects and a slow subscriber must not delay the response.
  private emitClosed(session: EscrowSession, reason: string, txHash?: string): void {
    void this.webhooksService.emit(WebhookEvent.ESCROW_CLOSED, {
      escrowId: session.id,
      status: session.status,
      reason,
      closedAt: session.closedAt?.toISOString() ?? null,
      txHash: txHash ?? null,
    });
  }

  getEscrowIdHash(id: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(id));
  }
}
