import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PlatformController } from './presentation/platform.controller';
import { PlatformAdminGuard } from './presentation/guards/platform-admin.guard';
import { ListTenantsUseCase } from './application/use-cases/list-tenants.use-case';
import { PLATFORM_REPOSITORY } from './domain/ports/platform-repository.port';
import { PrismaPlatformRepository } from './infrastructure/repositories/prisma-platform.repository';
import { TokenService } from '../../shared/crypto/token.service';

// JwtModule.register({}) igual que los demás módulos: JwtAuthGuard depende de
// TokenService, que depende de JwtService.
@Module({
  imports: [JwtModule.register({})],
  controllers: [PlatformController],
  providers: [
    ListTenantsUseCase,
    PlatformAdminGuard,
    TokenService,
    { provide: PLATFORM_REPOSITORY, useClass: PrismaPlatformRepository },
  ],
})
export class PlatformModule {}
