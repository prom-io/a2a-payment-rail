import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { Role } from '../../common/auth/roles.enum';
import { RolesGuard } from '../../common/auth/roles.guard';
import { SignerKeyringService } from '../../common/blockchain/signer-keyring.service';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin')
export class SignerController {
  constructor(private readonly keyring: SignerKeyringService) {}

  @Get('signer')
  @ApiOperation({ summary: 'Current signer address and the state of a key rotation, if one is in progress' })
  @ApiResponse({ status: 200, description: 'Addresses only; keys are never returned' })
  status() {
    return this.keyring.status();
  }
}
