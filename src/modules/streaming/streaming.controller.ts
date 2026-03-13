import { Controller, Post, Get, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { StreamingService } from './streaming.service';
import { ClaimStreamDto } from './dto/claim-stream.dto';

@ApiTags('streaming')
@Controller('streaming')
export class StreamingController {
  constructor(private readonly streamingService: StreamingService) {}

  @Post('claim')
  @ApiOperation({ summary: 'Submit a streaming micro-payment claim' })
  claim(@Body() dto: ClaimStreamDto) {
    return this.streamingService.claim(dto);
  }

  @Get(':escrowId')
  @ApiOperation({ summary: 'List streaming claims for an escrow' })
  findByEscrow(@Param('escrowId') escrowId: string) {
    return this.streamingService.findByEscrowId(escrowId);
  }
}
