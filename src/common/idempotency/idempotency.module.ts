import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyRecord } from './entities/idempotency-record.entity';
import { IdempotencyInterceptor } from './idempotency.interceptor';

// Global so any controller can opt in with @UseInterceptors(IdempotencyInterceptor)
// without its module importing the record repository.
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([IdempotencyRecord])],
  providers: [IdempotencyInterceptor],
  exports: [TypeOrmModule, IdempotencyInterceptor],
})
export class IdempotencyModule {}
