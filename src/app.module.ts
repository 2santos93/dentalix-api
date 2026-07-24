import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthController } from './health/health.controller';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './shared/prisma/prisma.module';
import { TenantContextModule } from './shared/tenancy/tenant-context.module';
import { AuthModule } from './modules/auth/auth.module';
import { PatientsModule } from './modules/patients/patients.module';
import { DentalCatalogModule } from './modules/dental-catalog/dental-catalog.module';
import { MedicalHistoryModule } from './modules/medical-history/medical-history.module';
import { ClinicalEntriesModule } from './modules/clinical-entries/clinical-entries.module';
import { OdontogramModule } from './modules/odontogram/odontogram.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { TreatmentPlansModule } from './modules/treatment-plans/treatment-plans.module';
import { StaffModule } from './modules/staff/staff.module';
import { DomainsModule } from './modules/domains/domains.module';
import { PublicBrandingModule } from './modules/public-branding/public-branding.module';
import { ExchangeModule } from './modules/exchange/exchange.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { TenantHostMiddleware } from './shared/tenancy/tenant-host.middleware';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    TenantContextModule,
    AuthModule,
    PatientsModule,
    DentalCatalogModule,
    MedicalHistoryModule,
    ClinicalEntriesModule,
    OdontogramModule,
    AppointmentsModule,
    TreatmentPlansModule,
    StaffModule,
    DomainsModule,
    PublicBrandingModule,
    ExchangeModule,
    PaymentsModule,
    InventoryModule,
    DashboardModule,
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantHostMiddleware).forRoutes('*');
  }
}
