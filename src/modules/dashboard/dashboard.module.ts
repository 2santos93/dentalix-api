import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { GetDoctorDashboardUseCase } from './application/use-cases/get-doctor-dashboard.use-case';
import { DashboardController } from './presentation/dashboard.controller';
import { SalesModule } from '../sales/sales.module';
import { InventoryModule } from '../inventory/inventory.module';
import { AppointmentsModule } from '../appointments/appointments.module';
import { PatientsModule } from '../patients/patients.module';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';

@Module({
  // JwtModule.register({}) mirrors SalesModule/InventoryModule/PatientsModule:
  // JwtAuthGuard depends on TokenService, which depends on JwtService --
  // must be available here since the guard is applied on DashboardController.
  // The 4 owner modules are imported (not their repositories) so
  // GetDoctorDashboardUseCase can inject their already-exported use cases by
  // class -- same cross-module DI pattern as SalesModule importing
  // ExchangeModule for ConvertAmountUseCase.
  imports: [
    JwtModule.register({}),
    SalesModule,
    InventoryModule,
    AppointmentsModule,
    PatientsModule,
  ],
  controllers: [DashboardController],
  providers: [
    GetDoctorDashboardUseCase,
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on DashboardController.
    TenantContextInterceptor,
  ],
  exports: [GetDoctorDashboardUseCase],
})
export class DashboardModule {}
