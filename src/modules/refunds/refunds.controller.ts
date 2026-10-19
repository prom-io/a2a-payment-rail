import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { RefundsService } from './refunds.service';

@ApiTags('refunds')
@Controller('refunds')
export class RefundsController {
  constructor(private readonly refundsService: RefundsService) {}

  @Post(':escrowId')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({ summary: 'Refund the unspent deposit of an expired or cancelled escrow' })
  @ApiParam({ name: 'escrowId', description: 'Escrow session UUID' })
  @ApiResponse({ status: 200, description: 'The refund of this escrow (existing one if already refunded)' })
  @ApiResponse({ status: 404, description: 'Escrow session not found' })
  @ApiResponse({ status: 409, description: 'Escrow is neither expired nor cancelled' })
  refund(@Param('escrowId', new ParseUUIDPipe()) escrowId: string) {
    return this.refundsService.refund(escrowId);
  }

  @Get(':escrowId')
  @ApiOperation({ summary: 'Get the refund of an escrow session' })
  @ApiParam({ name: 'escrowId', description: 'Escrow session UUID' })
  @ApiResponse({ status: 200, description: 'Refund found' })
  @ApiResponse({ status: 404, description: 'No refund for this escrow' })
  findOne(@Param('escrowId', new ParseUUIDPipe()) escrowId: string) {
    return this.refundsService.findByEscrowId(escrowId);
  }
}
