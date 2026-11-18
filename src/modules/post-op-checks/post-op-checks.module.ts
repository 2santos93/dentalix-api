import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { ClinicalEntriesModule } from '../clinical-entries/clinical-entries.module';
import {
  POST_OP_CHECKS_CLOCK,
  PostOpChecksUseCases,
} from './application/post-op-checks.use-cases';
import { POST_OP_CHECK_REPOSITORY } from './domain/post-op-check-repository.port';
import { PrismaPostOpCheckRepository } from './infrastructure/prisma-post-op-check.repository';
import { PostOpChecksController } from './presentation/post-op-checks.controller';

/**
 * Control postoperatorio (DX-566): la lista de llamadas del día y el registro
 * del desenlace. El alta, la anulación y el recálculo van en la transacción
 * del ítem del plan (`post-op-check-from-procedure.ts`).
 */
@Module({
  imports: [JwtModule.register({}), ClinicalEntriesModule],
  controllers: [PostOpChecksController],
  providers: [
    PostOpChecksUseCases,
    TokenService,
    TenantContextInterceptor,
    {
      provide: POST_OP_CHECK_REPOSITORY,
      useClass: PrismaPostOpCheckRepository,
    },
    { provide: POST_OP_CHECKS_CLOCK, useValue: () => new Date() },
  ],
  // «Mi día» cuenta la lista con el mismo caso de uso.
  exports: [PostOpChecksUseCases],
})
export class PostOpChecksModule {}
