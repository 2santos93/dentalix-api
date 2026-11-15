import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import {
  DismissOnboardingUseCase,
  GetOnboardingStatusUseCase,
} from './application/onboarding.use-cases';
import { ONBOARDING_REPOSITORY } from './domain/ports/onboarding-repository.port';
import { PrismaOnboardingRepository } from './infrastructure/prisma-onboarding.repository';
import { OnboardingController } from './presentation/onboarding.controller';

/** DX-020: tarjeta «Pon en marcha tu clínica» del panel del ADMIN. */
@Module({
  imports: [JwtModule.register({})],
  controllers: [OnboardingController],
  providers: [
    GetOnboardingStatusUseCase,
    DismissOnboardingUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: ONBOARDING_REPOSITORY, useClass: PrismaOnboardingRepository },
  ],
})
export class OnboardingModule {}
