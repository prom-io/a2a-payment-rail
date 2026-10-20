import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiHeader } from '@nestjs/swagger';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { EscrowService } from './escrow.service';
import { OpenEscrowDto } from './dto/open-escrow.dto';
import { ReleaseEscrowDto } from './dto/release-escrow.dto';
import { EscrowReleaseService } from './escrow-release.service';

@ApiTags('escrow')
@Controller('escrow')
export class EscrowController {
  constructor(
    private readonly escrowService: EscrowService,
    private readonly escrowReleaseService: EscrowReleaseService,
  ) {}

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Unique key; a retry with the same key and body replays the first response',
  })
  @ApiOperation({ summary: 'Open a new escrow session' })
  @ApiResponse({ status: 201, description: 'Escrow session created' })
  @ApiResponse({ status: 400, description: 'Invalid escrow parameters' })
  open(@Body() dto: OpenEscrowDto) {
    return this.escrowService.open(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get escrow session by ID' })
  @ApiParam({ name: 'id', description: 'Escrow session UUID' })
  @ApiResponse({ status: 200, description: 'Escrow session found' })
  @ApiResponse({ status: 404, description: 'Escrow session not found' })
  findOne(@Param('id') id: string) {
    return this.escrowService.findById(id);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Unique key; a retry with the same key and body replays the first response',
  })
  @ApiOperation({ summary: 'Close an escrow session' })
  @ApiResponse({ status: 200, description: 'Escrow closed and funds settled' })
  @ApiResponse({ status: 404, description: 'Escrow session not found' })
  @ApiResponse({ status: 409, description: 'Escrow already closed' })
  close(@Param('id') id: string) {
    return this.escrowService.close(id);
  }

  @Get(':id/balance')
  @ApiOperation({ summary: 'Deposit, released total and remaining balance of a session' })
  @ApiParam({ name: 'id', description: 'Escrow session UUID' })
  @ApiResponse({ status: 200, description: 'Balance returned' })
  @ApiResponse({ status: 404, description: 'Escrow session not found' })
  balance(@Param('id') id: string) {
    return this.escrowReleaseService.balance(id);
  }

  @Get(':id/releases')
  @ApiOperation({ summary: 'List the partial releases of a session' })
  @ApiParam({ name: 'id', description: 'Escrow session UUID' })
  @ApiResponse({ status: 200, description: 'Releases, oldest first' })
  releases(@Param('id') id: string) {
    return this.escrowReleaseService.findReleases(id);
  }

  @Post(':id/release')
  @UseInterceptors(IdempotencyInterceptor)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Unique key; a retry with the same key and body replays the first response',
  })
  @ApiOperation({ summary: 'Release part of the escrow to the payee and keep the session open' })
  @ApiParam({ name: 'id', description: 'Escrow session UUID' })
  @ApiResponse({ status: 201, description: 'Release recorded, new balance returned' })
  @ApiResponse({ status: 404, description: 'Escrow session not found' })
  @ApiResponse({ status: 409, description: 'Session is not open or the amount exceeds the remaining balance' })
  @ApiResponse({ status: 502, description: 'On-chain payout failed; the balance was not changed' })
  release(@Param('id') id: string, @Body() dto: ReleaseEscrowDto) {
    return this.escrowReleaseService.release(id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({
    summary: 'Cancel an open escrow session',
    description: 'Marks the session cancelled. The deposit is returned through POST /refunds/:escrowId.',
  })
  @ApiResponse({ status: 200, description: 'Escrow cancelled' })
  @ApiResponse({ status: 404, description: 'Escrow session not found' })
  @ApiResponse({ status: 409, description: 'Escrow is not open' })
  cancel(@Param('id') id: string) {
    return this.escrowService.cancel(id);
  }

  @Post(':id/emergency-close')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Unique key; a retry with the same key and body replays the first response',
  })
  @ApiOperation({ summary: 'Emergency close an escrow session' })
  @ApiResponse({ status: 200, description: 'Emergency close executed' })
  @ApiResponse({ status: 404, description: 'Escrow session not found' })
  emergencyClose(@Param('id') id: string) {
    return this.escrowService.emergencyClose(id);
  }
}
