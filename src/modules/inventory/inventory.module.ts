import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { InventoryController } from './presentation/inventory.controller';
import { CreateInventoryItemUseCase } from './application/use-cases/create-inventory-item.use-case';
import { ListInventoryItemsUseCase } from './application/use-cases/list-inventory-items.use-case';
import { GetInventoryItemUseCase } from './application/use-cases/get-inventory-item.use-case';
import { UpdateInventoryItemUseCase } from './application/use-cases/update-inventory-item.use-case';
import { DeleteInventoryItemUseCase } from './application/use-cases/delete-inventory-item.use-case';
import { RecordInventoryMovementUseCase } from './application/use-cases/record-inventory-movement.use-case';
import { INVENTORY_REPOSITORY } from './domain/ports/inventory-repository.port';
import { PrismaInventoryRepository } from './infrastructure/repositories/prisma-inventory.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';

@Module({
  // JwtModule.register({}) mirrors SalesModule/TreatmentPlansModule:
  // JwtAuthGuard depends on TokenService, which depends on JwtService --
  // must be available here since the guard is applied on this module's
  // controller. PrismaService/TenantContextService are @Global (see
  // PrismaModule/TenantContextModule in app.module.ts), so PrismaInventoryRepository
  // resolves them without an explicit import here.
  imports: [JwtModule.register({})],
  controllers: [InventoryController],
  providers: [
    CreateInventoryItemUseCase,
    ListInventoryItemsUseCase,
    GetInventoryItemUseCase,
    UpdateInventoryItemUseCase,
    DeleteInventoryItemUseCase,
    RecordInventoryMovementUseCase,
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on InventoryController.
    TenantContextInterceptor,
    {
      provide: INVENTORY_REPOSITORY,
      useClass: PrismaInventoryRepository,
    },
  ],
  // Exported (additive) so DashboardModule can inject
  // ListInventoryItemsUseCase by class for the low-stock aggregation.
  exports: [ListInventoryItemsUseCase],
})
export class InventoryModule {}
