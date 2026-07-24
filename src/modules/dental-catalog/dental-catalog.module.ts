import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DentalCatalogController } from './presentation/dental-catalog.controller';
import { CreateCatalogItemUseCase } from './application/use-cases/create-catalog-item.use-case';
import { ListCatalogItemsUseCase } from './application/use-cases/list-catalog-items.use-case';
import { UpdateCatalogItemUseCase } from './application/use-cases/update-catalog-item.use-case';
import { DENTAL_CATALOG_REPOSITORY } from './domain/ports/dental-catalog-repository.port';
import { PrismaDentalCatalogRepository } from './infrastructure/repositories/prisma-dental-catalog.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';

@Module({
  // JwtModule.register({}) mirrors PatientsModule: JwtAuthGuard depends on
  // TokenService, which depends on JwtService — must be available here since
  // the guard is applied on this module's controller.
  imports: [JwtModule.register({})],
  controllers: [DentalCatalogController],
  providers: [
    CreateCatalogItemUseCase,
    ListCatalogItemsUseCase,
    UpdateCatalogItemUseCase,
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on DentalCatalogController.
    TenantContextInterceptor,
    {
      provide: DENTAL_CATALOG_REPOSITORY,
      useClass: PrismaDentalCatalogRepository,
    },
  ],
  // Exported so other modules (TreatmentPlansModule ->
  // AddTreatmentPlanItemUseCase) can inject DENTAL_CATALOG_REPOSITORY to
  // validate `catalogItemId` / resolve `defaultPrice` without duplicating the
  // catalog repository.
  exports: [DENTAL_CATALOG_REPOSITORY],
})
export class DentalCatalogModule {}
