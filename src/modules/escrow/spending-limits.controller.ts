import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { Role } from '../../common/auth/roles.enum';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ParseEthereumAddressPipe } from '../../common/pipes/parse-ethereum-address.pipe';
import { SetSpendingLimitDto } from './dto/set-spending-limit.dto';
import { SpendingLimitService } from './spending-limit.service';

@ApiTags('spending-limits')
@Controller('spending-limits')
export class SpendingLimitsController {
  constructor(private readonly spendingLimitService: SpendingLimitService) {}

  @Get(':payer')
  @ApiOperation({ summary: 'Limit, amount spent in the rolling window and what remains' })
  @ApiParam({ name: 'payer', description: 'Payer (agent A) address' })
  @ApiResponse({ status: 200, description: 'Spending status of the payer' })
  @ApiResponse({ status: 400, description: 'Not an Ethereum address' })
  status(@Param('payer', ParseEthereumAddressPipe) payer: string) {
    return this.spendingLimitService.status(payer);
  }

  @Put(':payer')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set the daily limit of one payer ("0" lifts it for this payer)' })
  @ApiParam({ name: 'payer', description: 'Payer (agent A) address' })
  @ApiResponse({ status: 200, description: 'Spending status with the new limit' })
  async setLimit(
    @Param('payer', ParseEthereumAddressPipe) payer: string,
    @Body() dto: SetSpendingLimitDto,
  ) {
    await this.spendingLimitService.setLimit(payer, dto.dailyLimit);
    return this.spendingLimitService.status(payer);
  }

  @Delete(':payer')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Remove a payer's own limit so the default applies again" })
  @ApiParam({ name: 'payer', description: 'Payer (agent A) address' })
  @ApiResponse({ status: 204, description: 'Override removed' })
  clearLimit(@Param('payer', ParseEthereumAddressPipe) payer: string) {
    return this.spendingLimitService.clearLimit(payer);
  }
}
