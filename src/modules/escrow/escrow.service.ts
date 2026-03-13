import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EscrowSession, EscrowStatus } from './entities/escrow-session.entity';
import { OpenEscrowDto } from './dto/open-escrow.dto';

@Injectable()
export class EscrowService {
  constructor(
    @InjectRepository(EscrowSession)
    private readonly escrowRepo: Repository<EscrowSession>,
  ) {}

  async open(dto: OpenEscrowDto): Promise<EscrowSession> {
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
    return this.escrowRepo.save(session);
  }

  async findById(id: string): Promise<EscrowSession> {
    const session = await this.escrowRepo.findOne({ where: { id } });
    if (!session) throw new NotFoundException(`Escrow ${id} not found`);
    return session;
  }

  async close(id: string): Promise<EscrowSession> {
    const session = await this.findById(id);
    session.status = EscrowStatus.CLOSED;
    session.closedAt = new Date();
    return this.escrowRepo.save(session);
  }

  async emergencyClose(id: string): Promise<EscrowSession> {
    const session = await this.findById(id);
    session.status = EscrowStatus.CLOSED;
    session.closedAt = new Date();
    return this.escrowRepo.save(session);
  }
}
