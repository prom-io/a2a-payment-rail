import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { Role } from '../../common/auth/roles.enum';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { WithdrawFeesDto } from './dto/withdraw-fees.dto';
import { FeeLedgerService } from './fee-ledger.service';
import { FeePolicyService } from './fee-policy.service';

@ApiTags('fees')
@Controller('fees')
export class FeesController {
  constructor(
    private readonly feePolicyService: FeePolicyService,
    private readonly feeLedgerService: FeeLedgerService,
  ) {}

  @Get('quote')
  @ApiOperation({ summary: 'Quote the protocol fee for an amount' })
  @ApiQuery({ name: 'amount', description: 'Decimal amount in the native token, e.g. 1.5' })
  @ApiQuery({ name: 'chainId', required: false, description: 'Defaults to the configured chain' })
  @ApiResponse({ status: 200, description: 'Fee, net amount and the bound that applied' })
  @ApiResponse({ status: 400, description: 'Invalid amount or chain id' })
  quote(@Query('amount') amount: string, @Query('chainId') chainId?: string) {
    return this.feePolicyService.quote(String(amount ?? ''), parseChainId(chainId));
  }

  @Get('policies')
  @ApiOperation({ summary: 'List the default and per-chain fee policies' })
  @ApiResponse({ status: 200, description: 'Fee policies' })
  policies() {
    return this.feePolicyService.listPolicies();
  }

  @Get('ledger')
  @ApiOperation({ summary: 'Accrued, withdrawn and available protocol fees of a chain' })
  @ApiQuery({ name: 'chainId', required: false, description: 'Defaults to the configured chain' })
  @ApiResponse({ status: 200, description: 'Balance and the most recent ledger entries' })
  async ledger(@Query('chainId') chainId?: string) {
    const chain = parseChainId(chainId);
    const [balance, entries] = await Promise.all([
      this.feeLedgerService.balance(chain),
      this.feeLedgerService.recentEntries(chain),
    ]);
    return { balance, entries };
  }

  @Post('withdrawals')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Withdraw accrued protocol fees to a treasury address' })
  @ApiResponse({ status: 201, description: 'Withdrawal recorded, new balance returned' })
  @ApiResponse({ status: 409, description: 'Amount exceeds the accrued balance' })
  withdraw(@Body() dto: WithdrawFeesDto) {
    return this.feeLedgerService.withdraw(dto);
  }
}

function parseChainId(chainId: string | undefined): number | undefined {
  if (chainId === undefined) return undefined;
  if (!/^[1-9]\d{0,15}$/.test(chainId)) {
    throw new BadRequestException('chainId must be a positive integer');
  }
  return Number(chainId);
}
