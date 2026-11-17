import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { PublicTenantContextInterceptor } from '../../shared/tenancy/public-tenant-context.interceptor';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { JobQueue } from '../jobs/application/job-queue.service';
import { JobsModule } from '../jobs/jobs.module';
import { EmailModule } from '../notifications/email/email.module';
import { ReceivablesModule } from '../receivables/receivables.module';
import { ReportsModule } from '../reports/reports.module';
import { WeeklyDigestComposer } from './application/weekly-digest-composer';
import { WeeklyDigestJobs } from './application/weekly-digest-jobs';
import {
  WEEKLY_DIGEST_JOB_QUEUE,
  WeeklyDigestSender,
  WeeklyDigestSweep,
} from './application/weekly-digest-sender';
import {
  GetWeeklyDigestSettingsUseCase,
  SendWeeklyDigestTestUseCase,
  UpdateWeeklyDigestSettingsUseCase,
} from './application/weekly-digest-settings.use-cases';
import { WeeklyDigestSources } from './application/weekly-digest-sources';
import {
  ConfirmPublicWeeklyDigestUnsubscribeUseCase,
  GetPublicWeeklyDigestUnsubscribeUseCase,
} from './application/weekly-digest-unsubscribe.use-cases';
import {
  WEEKLY_DIGEST_CLOCK,
  WEEKLY_DIGEST_REPOSITORY,
} from './domain/ports/weekly-digest-repository.port';
import { PrismaWeeklyDigestRepository } from './infrastructure/prisma-weekly-digest.repository';
import { PublicWeeklyDigestUnsubscribeController } from './presentation/public-weekly-digest-unsubscribe.controller';
import { WeeklyDigestSettingsController } from './presentation/weekly-digest-settings.controller';

// Resumen semanal por email para el dueño (DX-568): ajustes, prueba, envío
// semanal (barrido horario + trabajo por clínica) y baja pública. Las cifras
// salen de Reportes (Comparar sedes, embudo de presupuestos) y de la cartera.
@Module({
  imports: [
    JwtModule.register({}),
    JobsModule,
    EmailModule,
    ReportsModule,
    ReceivablesModule,
  ],
  controllers: [
    WeeklyDigestSettingsController,
    PublicWeeklyDigestUnsubscribeController,
  ],
  providers: [
    GetWeeklyDigestSettingsUseCase,
    UpdateWeeklyDigestSettingsUseCase,
    SendWeeklyDigestTestUseCase,
    GetPublicWeeklyDigestUnsubscribeUseCase,
    ConfirmPublicWeeklyDigestUnsubscribeUseCase,
    WeeklyDigestSources,
    WeeklyDigestComposer,
    WeeklyDigestSender,
    WeeklyDigestSweep,
    WeeklyDigestJobs,
    TokenService,
    TenantContextInterceptor,
    PublicTenantContextInterceptor,
    {
      provide: WEEKLY_DIGEST_REPOSITORY,
      useClass: PrismaWeeklyDigestRepository,
    },
    { provide: WEEKLY_DIGEST_JOB_QUEUE, useExisting: JobQueue },
    { provide: WEEKLY_DIGEST_CLOCK, useValue: () => new Date() },
  ],
})
export class WeeklyDigestModule {}
