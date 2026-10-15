import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { Role } from '../../common/auth/roles.enum';
import { RolesGuard } from '../../common/auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { WebhooksService } from './webhooks.service';

// A subscription decides where payment events are sent, so managing them is
// not something an anonymous caller or an ordinary agent may do.
@ApiTags('webhooks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.SERVICE)
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post()
  @ApiOperation({ summary: 'Subscribe an endpoint to escrow and settlement events' })
  @ApiResponse({ status: 201, description: 'Subscription created; the secret is shown only here' })
  @ApiResponse({ status: 400, description: 'Invalid url or event list' })
  create(@Body() dto: CreateWebhookDto) {
    return this.webhooksService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List webhook subscriptions (without secrets)' })
  @ApiResponse({ status: 200, description: 'Subscriptions' })
  list() {
    return this.webhooksService.list();
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a webhook subscription' })
  @ApiParam({ name: 'id', description: 'Subscription UUID' })
  @ApiResponse({ status: 204, description: 'Subscription removed' })
  @ApiResponse({ status: 404, description: 'Subscription not found' })
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.webhooksService.remove(id);
  }

  @Post(':id/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Issue a new signing secret for a subscription' })
  @ApiParam({ name: 'id', description: 'Subscription UUID' })
  @ApiResponse({ status: 200, description: 'Subscription with its new secret, shown only here' })
  @ApiResponse({ status: 404, description: 'Subscription not found' })
  rotateSecret(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.webhooksService.rotateSecret(id);
  }

  @Get(':id/deliveries')
  @ApiOperation({ summary: 'Most recent deliveries of a subscription' })
  @ApiParam({ name: 'id', description: 'Subscription UUID' })
  @ApiResponse({ status: 200, description: 'Deliveries, newest first' })
  deliveries(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.webhooksService.listDeliveries(id);
  }
}
