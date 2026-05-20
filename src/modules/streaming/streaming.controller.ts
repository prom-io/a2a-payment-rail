import { Controller, Post, Get, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { StreamingService } from './streaming.service';
import { ClaimStreamDto } from './dto/claim-stream.dto';
import { RefundStreamDto } from './dto/refund-stream.dto';

@ApiTags('streaming')
@Controller('streaming')
export class StreamingController {
  constructor(private readonly streamingService: StreamingService) {}

  @Post('claim')
  @ApiOperation({ summary: 'Submit a streaming micro-payment claim' })
  @ApiResponse({ status: 201, description: 'Claim recorded' })
  @ApiResponse({ status: 400, description: 'Invalid claim data' })
  @ApiResponse({ status: 409, description: 'Budget limit exceeded' })
  claim(@Body() dto: ClaimStreamDto) {
    return this.streamingService.claim(dto);
  }

  @Post('refund')
  @ApiOperation({
    summary: 'Refund unclaimed deposit on early termination',
    description:
      'Closes the escrow session and computes the refundable balance: deposit minus the sum of all streaming claims.',
  })
  @ApiResponse({ status: 201, description: 'Refund computed and escrow closed' })
  @ApiResponse({ status: 400, description: 'Escrow already closed or invalid' })
  @ApiResponse({ status: 404, description: 'Escrow not found' })
  refund(@Body() dto: RefundStreamDto) {
    return this.streamingService.refundUnused(dto.escrowId, dto.reason);
  }

  @Get(':escrowId')
  @ApiOperation({ summary: 'List streaming claims for an escrow' })
  @ApiParam({ name: 'escrowId', description: 'Parent escrow session UUID' })
  @ApiResponse({ status: 200, description: 'Claims list returned' })
  findByEscrow(@Param('escrowId') escrowId: string) {
    return this.streamingService.findByEscrowId(escrowId);
  }
}
