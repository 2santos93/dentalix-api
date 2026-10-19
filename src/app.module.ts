import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthController } from './health/health.controller';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './shared/prisma/prisma.module';
import { TenantContextModule } from './shared/tenancy/tenant-context.module';
import { AuthModule } from './modules/auth/auth.module';
import { MeModule } from './modules/me/me.module';
import { PatientsModule } from './modules/patients/patients.module';
import { DentalCatalogModule } from './modules/dental-catalog/dental-catalog.module';
import { MedicalHistoryModule } from './modules/medical-history/medical-history.module';
import { ClinicalEntriesModule } from './modules/clinical-entries/clinical-entries.module';
import { ClinicalNoteTemplatesModule } from './modules/clinical-note-templates/clinical-note-templates.module';
import { OdontogramModule } from './modules/odontogram/odontogram.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { AppointmentTypesModule } from './modules/appointment-types/appointment-types.module';
import { ScheduleBlocksModule } from './modules/schedule-blocks/schedule-blocks.module';
import { WaitlistModule } from './modules/waitlist/waitlist.module';
import { AppointmentConfirmationsModule } from './modules/appointment-confirmations/appointment-confirmations.module';
import { TreatmentPlansModule } from './modules/treatment-plans/treatment-plans.module';
import { StaffModule } from './modules/staff/staff.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { DomainsModule } from './modules/domains/domains.module';
import { PublicBrandingModule } from './modules/public-branding/public-branding.module';
import { ExchangeModule } from './modules/exchange/exchange.module';
import { ReferenceModule } from './modules/reference/reference.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PaymentPlansModule } from './modules/payment-plans/payment-plans.module';
import { AccountStatementModule } from './modules/account-statement/account-statement.module';
import { ReceivablesModule } from './modules/receivables/receivables.module';
import { DiscountsModule } from './modules/discounts/discounts.module';
import { CollectionsModule } from './modules/collections/collections.module';
import { CashSessionsModule } from './modules/cash-sessions/cash-sessions.module';
import { DataConsentsModule } from './modules/data-consents/data-consents.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { LocationsModule } from './modules/locations/locations.module';
import { LocationScheduleModule } from './modules/location-schedule/location-schedule.module';
import { PlatformModule } from './modules/platform/platform.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { ConsentsModule } from './modules/consents/consents.module';
import { PeriodontalModule } from './modules/periodontal/periodontal.module';
import { PrescriptionsModule } from './modules/prescriptions/prescriptions.module';
import { ImplantsModule } from './modules/implants/implants.module';
import { AuditModule } from './modules/audit/audit.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { OutboundMessagesModule } from './modules/notifications/outbound/outbound-messages.module';
import { RemindersModule } from './modules/reminders/reminders.module';
import { SecurityModule } from './shared/security/security.module';
import { SupportAccessesModule } from './modules/support-accesses/support-accesses.module';
import { TenantHostMiddleware } from './shared/tenancy/tenant-host.middleware';

@Module({
  imports: [
    ConfigModule,
    SecurityModule,
    PrismaModule,
    TenantContextModule,
    // Global: el AuditInterceptor de `@Audit(...)` se instancia en los
    // controladores de muchos módulos (DX-009).
    AuditModule,
    AuthModule,
    // InvitationsModule ANTES que cualquier módulo que registre StaffModule
    // (AppointmentsModule lo importa): Express casa las rutas en orden de
    // registro y `GET /staff/:userId` capturaría `GET /staff/invitations`
    // (400 por ParseUUIDPipe, DX-068). Lo vigila src/auth-matrix.spec.ts.
    InvitationsModule,
    MeModule,
    PatientsModule,
    DentalCatalogModule,
    MedicalHistoryModule,
    ClinicalEntriesModule,
    ClinicalNoteTemplatesModule,
    OdontogramModule,
    AppointmentsModule,
    AppointmentTypesModule,
    ScheduleBlocksModule,
    WaitlistModule,
    AppointmentConfirmationsModule,
    TreatmentPlansModule,
    StaffModule,
    DomainsModule,
    PublicBrandingModule,
    ExchangeModule,
    ReferenceModule,
    PaymentsModule,
    PaymentPlansModule,
    AccountStatementModule,
    ReceivablesModule,
    DiscountsModule,
    // DX-150: cobranza (notas, compromisos de pago y marca «Saldo vencido»).
    CollectionsModule,
    // DX-027: caja por turno (apertura, cierre con arqueo, reapertura).
    CashSessionsModule,
    DataConsentsModule,
    InventoryModule,
    LocationsModule,
    LocationScheduleModule,
    PlatformModule,
    // Accesos de soporte (break-glass) visibles para el ADMIN (SEC-008).
    SupportAccessesModule,
    DashboardModule,
    ConsentsModule,
    PeriodontalModule,
    PrescriptionsModule,
    ImplantsModule,
    // Trabajos en segundo plano (DX-085): cola, tareas programadas y worker
    // (APP_ROLE=worker|all), y el registro de mensajes salientes.
    JobsModule,
    OutboundMessagesModule,
    // Recordatorio automático de cita por email, por sede (DX-026).
    RemindersModule,
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Las sondas no resuelven tenant: la liveness no puede depender de la
    // base y la readiness ya la consulta ella misma (DX-023).
    consumer
      .apply(TenantHostMiddleware)
      .exclude('health', 'health/ready')
      .forRoutes('*');
  }
}
