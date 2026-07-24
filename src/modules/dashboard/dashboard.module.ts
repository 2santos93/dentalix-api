import { Module } from '@nestjs/common';
import { GetDoctorDashboardUseCase } from './application/use-cases/get-doctor-dashboard.use-case';
import { SalesModule } from '../sales/sales.module';
import { InventoryModule } from '../inventory/inventory.module';
import { AppointmentsModule } from '../appointments/appointments.module';
import { PatientsModule } from '../patients/patients.module';

@Module({
  // Imports the 4 owner modules (not their repositories) so
  // GetDoctorDashboardUseCase can inject their already-exported use cases
  // by class -- same cross-module DI pattern as SalesModule importing
  // ExchangeModule for ConvertAmountUseCase. Controller + app.module
  // registration land in Task 2.
  imports: [SalesModule, InventoryModule, AppointmentsModule, PatientsModule],
  providers: [GetDoctorDashboardUseCase],
  exports: [GetDoctorDashboardUseCase],
})
export class DashboardModule {}
