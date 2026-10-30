import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { SedationUseCases } from './application/use-cases/sedation.use-cases';
import { SEDATION_REPOSITORY } from './domain/ports/sedation-repository.port';
import { SEDATION_TEMPLATE_SOURCE } from './domain/ports/sedation-template-source.port';
import { PlatformSedationTemplateSource } from './infrastructure/platform-sedation-template.source';
import { PrismaSedationRepository } from './infrastructure/repositories/prisma-sedation.repository';
import { SedationController } from './presentation/sedation.controller';

/**
 * Hoja de sedación consciente en la evolución (DX-407, porción 2 de DX-307):
 * valoración previa, checklist, fármacos, constantes por tiempo y egreso,
 * append-only. La plantilla sale de `SEDATION_TEMPLATE_SOURCE` (hoy la de
 * plataforma; DX-409 la hará por clínica). Exporta los casos de uso para la
 * clínica demo.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [SedationController],
  providers: [
    SedationUseCases,
    TokenService,
    TenantContextInterceptor,
    { provide: SEDATION_REPOSITORY, useClass: PrismaSedationRepository },
    {
      provide: SEDATION_TEMPLATE_SOURCE,
      useClass: PlatformSedationTemplateSource,
    },
  ],
  exports: [SedationUseCases],
})
export class SedationModule {}
