import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { CancellationPolicyController } from './presentation/cancellation-policy.controller';
import {
  CreateCancellationPolicyVersionUseCase,
  GetCancellationPolicyUseCase,
  PreviewReminderEmailUseCase,
} from './application/use-cases/cancellation-policy.use-cases';
import { EmailModule } from '../notifications/email/email.module';
import { CANCELLATION_POLICY_REPOSITORY } from './domain/ports/cancellation-policy-repository.port';
import { PrismaCancellationPolicyRepository } from './infrastructure/prisma-cancellation-policy.repository';

/**
 * DX-279: política de cancelación por sede (versiones append-only). La
 * política vigente la leen además, dentro de sus transacciones, la agenda al
 * cancelar y el enlace público de confirmación (`findCurrentPolicyInTx`).
 */
@Module({
  imports: [JwtModule.register({}), EmailModule],
  controllers: [CancellationPolicyController],
  providers: [
    GetCancellationPolicyUseCase,
    CreateCancellationPolicyVersionUseCase,
    PreviewReminderEmailUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: CANCELLATION_POLICY_REPOSITORY,
      useClass: PrismaCancellationPolicyRepository,
    },
  ],
})
export class CancellationPoliciesModule {}
