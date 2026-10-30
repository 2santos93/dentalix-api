import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { AnesthesiaUseCases } from './application/use-cases/anesthesia.use-cases';
import { AnestheticCatalogUseCases } from './application/use-cases/anesthetic-catalog.use-cases';
import { ANESTHESIA_REPOSITORY } from './domain/ports/anesthesia-repository.port';
import { PrismaAnesthesiaRepository } from './infrastructure/repositories/prisma-anesthesia.repository';
import { AnesthesiaController } from './presentation/anesthesia.controller';
import { AnestheticsController } from './presentation/anesthetics.controller';

/**
 * Anestesia local en la evolución (DX-307): catálogo de anestésicos de la
 * clínica y registro (append-only) con el cálculo de la dosis máxima por peso.
 * Exporta los casos de uso del catálogo para la clínica demo.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AnestheticsController, AnesthesiaController],
  providers: [
    AnesthesiaUseCases,
    AnestheticCatalogUseCases,
    TokenService,
    TenantContextInterceptor,
    { provide: ANESTHESIA_REPOSITORY, useClass: PrismaAnesthesiaRepository },
  ],
  exports: [AnestheticCatalogUseCases, AnesthesiaUseCases],
})
export class AnesthesiaModule {}
