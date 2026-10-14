import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhookDelivery } from './entities/webhook-delivery.entity';
import { WebhookSubscription } from './entities/webhook-subscription.entity';
import { WebhookTransport } from './webhook-transport';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

// Global: escrow and settlement emit events without importing this module,
// which keeps the dependency pointing one way.
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([WebhookSubscription, WebhookDelivery])],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookTransport],
  exports: [WebhooksService],
})
export class WebhooksModule {}
