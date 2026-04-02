import { Controller, Post, Get, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { EscrowService } from './escrow.service';
import { OpenEscrowDto } from './dto/open-escrow.dto';

@ApiTags('escrow')
@Controller('escrow')
export class EscrowController {
  constructor(private readonly escrowService: EscrowService) {}

  @Post()
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
  @ApiOperation({ summary: 'Close an escrow session' })
  @ApiResponse({ status: 200, description: 'Escrow closed and funds settled' })
  @ApiResponse({ status: 404, description: 'Escrow session not found' })
  @ApiResponse({ status: 409, description: 'Escrow already closed' })
  close(@Param('id') id: string) {
    return this.escrowService.close(id);
  }

  @Post(':id/emergency-close')
  @ApiOperation({ summary: 'Emergency close an escrow session' })
  @ApiResponse({ status: 200, description: 'Emergency close executed' })
  @ApiResponse({ status: 404, description: 'Escrow session not found' })
  emergencyClose(@Param('id') id: string) {
    return this.escrowService.emergencyClose(id);
  }
}
