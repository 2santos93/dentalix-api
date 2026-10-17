import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { SupportAccessesController } from './presentation/support-accesses.controller';
import { ListSupportAccessesUseCase } from './application/list-support-accesses.use-case';
import { SUPPORT_ACCESS_REPOSITORY } from './domain/ports/support-access-repository.port';
import { PrismaSupportAccessRepository } from './infrastructure/prisma-support-access.repository';

/**
 * «Accesos de soporte» (SEC-008): el ADMIN de la clínica ve cada acceso
 * break-glass de un superadmin. Las filas las escribe el login
 * (BreakGlassService, AuthModule) en `platform_access_audit`.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [SupportAccessesController],
  providers: [
    ListSupportAccessesUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: SUPPORT_ACCESS_REPOSITORY,
      useClass: PrismaSupportAccessRepository,
    },
  ],
})
export class SupportAccessesModule {}
