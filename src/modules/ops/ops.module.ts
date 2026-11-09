import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemFlag } from './entities/system-flag.entity';
import { PauseController } from './pause.controller';
import { PauseService } from './pause.service';
import { SignerController } from './signer.controller';

// Global: the pause switch is checked from settlement, escrow and streaming,
// none of which should have to import an operations module to do so.
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([SystemFlag])],
  controllers: [PauseController, SignerController],
  providers: [PauseService],
  exports: [PauseService],
})
export class OpsModule {}
