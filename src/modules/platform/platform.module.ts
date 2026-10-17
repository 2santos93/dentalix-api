import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PlatformController } from './presentation/platform.controller';
import { PlatformAdminGuard } from './presentation/guards/platform-admin.guard';
import { ListTenantsUseCase } from './application/use-cases/list-tenants.use-case';
import { PLATFORM_REPOSITORY } from './domain/ports/platform-repository.port';
import { PrismaPlatformRepository } from './infrastructure/repositories/prisma-platform.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { JobsModule } from '../jobs/jobs.module';
import { PlatformJobsController } from './presentation/platform-jobs.controller';
import { PlatformMfaController } from './presentation/platform-mfa.controller';
import { PlatformMfaUseCase } from './application/use-cases/platform-mfa.use-case';
import { PLATFORM_MFA_REPOSITORY } from './domain/ports/platform-mfa-repository.port';
import { PrismaPlatformMfaRepository } from './infrastructure/repositories/prisma-platform-mfa.repository';
import { mfaSecretCipherProvider } from '../../shared/crypto/mfa-secret-cipher';

// JwtModule.register({}) igual que los demás módulos: JwtAuthGuard depende de
// TokenService, que depende de JwtService.
@Module({
  // JobsModule: cola de fallidos (DX-085).
  imports: [JwtModule.register({}), JobsModule],
  controllers: [
    PlatformController,
    PlatformJobsController,
    PlatformMfaController,
  ],
  providers: [
    ListTenantsUseCase,
    PlatformAdminGuard,
    TokenService,
    { provide: PLATFORM_REPOSITORY, useClass: PrismaPlatformRepository },
    // MFA del superadmin, obligatorio para el break-glass (SEC-008).
    PlatformMfaUseCase,
    { provide: PLATFORM_MFA_REPOSITORY, useClass: PrismaPlatformMfaRepository },
    mfaSecretCipherProvider,
  ],
})
export class PlatformModule {}
