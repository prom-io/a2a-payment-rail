import { Controller, Post, Get, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { EscrowService } from './escrow.service';
import { OpenEscrowDto } from './dto/open-escrow.dto';

@ApiTags('escrow')
@Controller('escrow')
export class EscrowController {
  constructor(private readonly escrowService: EscrowService) {}

  @Post()
  @ApiOperation({ summary: 'Open a new escrow session' })
  open(@Body() dto: OpenEscrowDto) {
    return this.escrowService.open(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get escrow session by ID' })
  findOne(@Param('id') id: string) {
    return this.escrowService.findById(id);
  }

  @Post(':id/close')
  @ApiOperation({ summary: 'Close an escrow session' })
  close(@Param('id') id: string) {
    return this.escrowService.close(id);
  }

  @Post(':id/emergency-close')
  @ApiOperation({ summary: 'Emergency close an escrow session' })
  emergencyClose(@Param('id') id: string) {
    return this.escrowService.emergencyClose(id);
  }
}
