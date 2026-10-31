import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { StorageModule } from '../../shared/storage/storage.module';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { JobQueue } from '../jobs/application/job-queue.service';
import { JobsModule } from '../jobs/jobs.module';
import { PatientMedicalAlertFlags } from '../medical-history/application/patient-medical-alert-flags';
import { MedicalHistoryModule } from '../medical-history/medical-history.module';
import { ContingencyAgendaJobs } from './application/contingency-agenda-jobs';
import {
  CONTINGENCY_JOB_QUEUE,
  CONTINGENCY_MEDICAL_FLAGS,
  ContingencyAgendaUseCases,
  ContingencyNightlySweep,
} from './application/contingency-agenda.use-cases';
import {
  CONTINGENCY_AGENDA_CLOCK,
  CONTINGENCY_AGENDA_REPOSITORY,
} from './domain/ports/contingency-agenda-repository.port';
import {
  CONTINGENCY_AGENDA_RENDERER,
  PdfkitContingencyAgendaRenderer,
} from './infrastructure/pdf/contingency-agenda-pdf.renderer';
import { PrismaContingencyAgendaRepository } from './infrastructure/prisma-contingency-agenda.repository';
import { ContingencyAgendaController } from './presentation/contingency-agenda.controller';

// Agenda de contingencia por sede (DX-339): PDF de hoy y mañana a demanda y
// copia nocturna, para trabajar en papel si cae la nube o internet.
@Module({
  imports: [
    JwtModule.register({}),
    JobsModule,
    StorageModule,
    // DX-247: la bandera «alerta médica» de cada cita, sin la historia.
    MedicalHistoryModule,
  ],
  controllers: [ContingencyAgendaController],
  providers: [
    ContingencyAgendaUseCases,
    ContingencyNightlySweep,
    ContingencyAgendaJobs,
    TokenService,
    TenantContextInterceptor,
    {
      provide: CONTINGENCY_AGENDA_REPOSITORY,
      useClass: PrismaContingencyAgendaRepository,
    },
    {
      provide: CONTINGENCY_AGENDA_RENDERER,
      useValue: new PdfkitContingencyAgendaRenderer(),
    },
    {
      provide: CONTINGENCY_MEDICAL_FLAGS,
      useExisting: PatientMedicalAlertFlags,
    },
    { provide: CONTINGENCY_JOB_QUEUE, useExisting: JobQueue },
    { provide: CONTINGENCY_AGENDA_CLOCK, useValue: () => new Date() },
  ],
})
export class ContingencyAgendaModule {}
