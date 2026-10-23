import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { JobsModule } from '../jobs/jobs.module';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import {
  loadImportReadConcurrency,
  loadUploadTimeouts,
} from '../../shared/storage/storage-config';
import {
  UploadSlotInterceptor,
  UploadSlots,
} from '../../shared/storage/upload-slots';
import {
  IMPORT_READ_SLOTS,
  ImportReadSlotGuard,
} from './presentation/import-read-slots';
import { PatientImportsController } from './presentation/patient-imports.controller';
import { PatientImportsService } from './application/patient-imports.use-cases';
import { PatientImportJobs } from './application/patient-import-jobs';
import { PrismaPatientImportRepository } from './infrastructure/prisma-patient-import.repository';

/**
 * Importación de pacientes desde CSV/XLSX (DX-107): dry-run, confirmación en
 * la cola de DX-085 (por bloques, sin bloquear la clínica), informe de
 * errores, historial y deshacer. Lo reutilizarán el saldo inicial (DX-262) y
 * las citas futuras (DX-263).
 */
@Module({
  // JwtModule.register({}): JwtAuthGuard -> TokenService -> JwtService.
  imports: [JwtModule.register({}), JobsModule],
  controllers: [PatientImportsController],
  providers: [
    PatientImportsService,
    PatientImportJobs,
    PrismaPatientImportRepository,
    TokenService,
    TenantContextInterceptor,
    {
      // SEC-046: lecturas de ficheros de importación a la vez (réplica y
      // clínica), con los plazos de recepción del cuerpo de DX-259.
      provide: IMPORT_READ_SLOTS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): UploadSlots => {
        const get = (key: string) => config.get<string>(key);
        const { perReplica, perClinic } = loadImportReadConcurrency(get);
        return new UploadSlots(perReplica, loadUploadTimeouts(get), perClinic);
      },
    },
    ImportReadSlotGuard,
    UploadSlotInterceptor,
  ],
})
export class PatientImportsModule {}
