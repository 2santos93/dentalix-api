import { Module } from '@nestjs/common';
import { JobQueue } from '../jobs/application/job-queue.service';
import { JobsModule } from '../jobs/jobs.module';
import { EmailModule } from '../notifications/email/email.module';
import { RemindersModule } from '../reminders/reminders.module';
import { SignatureRequestsModule } from '../signature-requests/signature-requests.module';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { QuoteFollowUpJobs } from './application/quote-follow-up-jobs';
import { SetQuoteFollowUpPausedUseCase } from './application/quote-follow-up-pause.use-cases';
import { GetQuoteFollowUpReportUseCase } from './application/quote-follow-up-report.use-case';
import {
  QUOTE_FOLLOW_UP_JOB_QUEUE,
  QuoteFollowUpSender,
  QuoteFollowUpSweep,
} from './application/quote-follow-up-sender';
import {
  ListQuoteFollowUpSettingsUseCase,
  UpdateQuoteFollowUpSettingsUseCase,
} from './application/quote-follow-up-settings.use-cases';
import {
  QUOTE_FOLLOW_UP_CLOCK,
  QUOTE_FOLLOW_UP_REPOSITORY,
} from './domain/ports/quote-follow-up-repository.port';
import { PrismaQuoteFollowUpRepository } from './infrastructure/prisma-quote-follow-up.repository';
import { QuoteFollowUpPauseController } from './presentation/quote-follow-up-pause.controller';
import { QuoteFollowUpReportController } from './presentation/quote-follow-up-report.controller';
import { QuoteFollowUpSettingsController } from './presentation/quote-follow-up-settings.controller';

/**
 * Seguimiento automático de presupuestos presentados (DX-561): ajustes por
 * sede, barrido horario + aviso por grupo y paso (con las solicitudes de
 * aceptación de DX-415 y la baja de DX-128), pausa y el informe de
 * efectividad.
 */
@Module({
  imports: [JobsModule, EmailModule, RemindersModule, SignatureRequestsModule],
  controllers: [
    QuoteFollowUpSettingsController,
    QuoteFollowUpPauseController,
    QuoteFollowUpReportController,
  ],
  providers: [
    ListQuoteFollowUpSettingsUseCase,
    UpdateQuoteFollowUpSettingsUseCase,
    SetQuoteFollowUpPausedUseCase,
    GetQuoteFollowUpReportUseCase,
    QuoteFollowUpSender,
    QuoteFollowUpSweep,
    QuoteFollowUpJobs,
    TenantContextInterceptor,
    {
      provide: QUOTE_FOLLOW_UP_REPOSITORY,
      useClass: PrismaQuoteFollowUpRepository,
    },
    { provide: QUOTE_FOLLOW_UP_JOB_QUEUE, useExisting: JobQueue },
    { provide: QUOTE_FOLLOW_UP_CLOCK, useValue: () => new Date() },
  ],
})
export class QuoteFollowUpModule {}
