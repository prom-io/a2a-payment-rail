import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FeePolicyService } from './fee-policy.service';

@ApiTags('fees')
@Controller('fees')
export class FeesController {
  constructor(private readonly feePolicyService: FeePolicyService) {}

  @Get('quote')
  @ApiOperation({ summary: 'Quote the protocol fee for an amount' })
  @ApiQuery({ name: 'amount', description: 'Decimal amount in the native token, e.g. 1.5' })
  @ApiQuery({ name: 'chainId', required: false, description: 'Defaults to the configured chain' })
  @ApiResponse({ status: 200, description: 'Fee, net amount and the bound that applied' })
  @ApiResponse({ status: 400, description: 'Invalid amount or chain id' })
  quote(@Query('amount') amount: string, @Query('chainId') chainId?: string) {
    if (chainId !== undefined && !/^[1-9]\d{0,15}$/.test(chainId)) {
      throw new BadRequestException('chainId must be a positive integer');
    }
    return this.feePolicyService.quote(
      String(amount ?? ''),
      chainId === undefined ? undefined : Number(chainId),
    );
  }

  @Get('policies')
  @ApiOperation({ summary: 'List the default and per-chain fee policies' })
  @ApiResponse({ status: 200, description: 'Fee policies' })
  policies() {
    return this.feePolicyService.listPolicies();
  }
}
