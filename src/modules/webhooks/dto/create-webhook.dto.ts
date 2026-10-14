import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { WEBHOOK_EVENTS, WebhookEvent } from '../webhook-events';

export class CreateWebhookDto {
  @ApiProperty({ description: 'Endpoint that receives the events (https in production)' })
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true, require_tld: false },
    { message: 'url must be an http(s) URL' },
  )
  @MaxLength(2048)
  url!: string;

  @ApiProperty({ description: 'Events to subscribe to', enum: WEBHOOK_EVENTS, isArray: true })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(WEBHOOK_EVENTS.length)
  @IsIn(WEBHOOK_EVENTS, { each: true, message: `each event must be one of: ${WEBHOOK_EVENTS.join(', ')}` })
  events!: WebhookEvent[];

  @ApiProperty({ required: false, description: 'Who owns the endpoint' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;
}
