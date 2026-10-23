import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { DentalCatalogModule } from '../dental-catalog/dental-catalog.module';
import { LocationsModule } from '../locations/locations.module';
import { PayersModule } from '../payers/payers.module';
import { PriceListsModule } from '../price-lists/price-lists.module';
import { AgreementsController } from './presentation/agreements.controller';
import {
  CreateAgreementUseCase,
  DeleteAgreementUseCase,
  ListAgreementsUseCase,
  UpdateAgreementUseCase,
} from './application/use-cases/agreements.use-cases';
import { AGREEMENT_REPOSITORY } from './domain/ports/agreement-repository.port';
import { PrismaAgreementRepository } from './infrastructure/repositories/prisma-agreement.repository';

/**
 * Convenios por pagador (DX-105): descuento porcentual o lista de precios.
 * Exporta el repositorio para que la asignación a pacientes y la resolución de
 * precios del plan lean el convenio (`findLiveById`) sin re-implementarlo.
 */
@Module({
  imports: [
    JwtModule.register({}),
    DentalCatalogModule,
    LocationsModule,
    PayersModule,
    PriceListsModule,
  ],
  controllers: [AgreementsController],
  providers: [
    ListAgreementsUseCase,
    CreateAgreementUseCase,
    UpdateAgreementUseCase,
    DeleteAgreementUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: AGREEMENT_REPOSITORY, useClass: PrismaAgreementRepository },
  ],
  exports: [AGREEMENT_REPOSITORY],
})
export class AgreementsModule {}
