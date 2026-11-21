import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { StorageModule } from '../../shared/storage/storage.module';
import { JobQueue } from '../jobs/application/job-queue.service';
import { JobsModule } from '../jobs/jobs.module';
import { EmailModule } from '../notifications/email/email.module';
import {
  CLINIC_EXPORT_JOB_QUEUE,
  ClinicExportBuilder,
} from './application/clinic-export-builder';
import { ClinicExportJobs } from './application/clinic-export-jobs';
import { ClinicExportsUseCases } from './application/clinic-exports.use-cases';
import {
  CLINIC_EXPORT_CLOCK,
  CLINIC_EXPORT_REPOSITORY,
} from './domain/ports/clinic-export-repository.port';
import { PrismaClinicExportRepository } from './infrastructure/prisma-clinic-export.repository';
import { ClinicExportsController } from './presentation/clinic-exports.controller';

// DX-053: exportación de los datos de la clínica (ZIP de CSV) desde Ajustes:
// pedirla (trabajo en la cola), historial, descarga de un solo uso y borrado
// del fichero a los 7 días.
@Module({
  imports: [JwtModule.register({}), JobsModule, EmailModule, StorageModule],
  controllers: [ClinicExportsController],
  providers: [
    ClinicExportsUseCases,
    ClinicExportBuilder,
    ClinicExportJobs,
    TenantContextInterceptor,
    TokenService,
    {
      provide: CLINIC_EXPORT_REPOSITORY,
      useClass: PrismaClinicExportRepository,
    },
    { provide: CLINIC_EXPORT_JOB_QUEUE, useExisting: JobQueue },
    { provide: CLINIC_EXPORT_CLOCK, useValue: () => new Date() },
  ],
})
export class ClinicExportsModule {}
