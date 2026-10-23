import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { JobsModule } from '../jobs/jobs.module';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { StorageModule } from '../../shared/storage/storage.module';
import { loadImportReadConcurrency } from '../../shared/storage/storage-config';
import {
  DEFAULT_UPLOAD_TIMEOUTS,
  UploadSlots,
} from '../../shared/storage/upload-slots';
import {
  IMPORT_READ_SLOTS,
  ImportReadSlotInterceptor,
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
  imports: [JwtModule.register({}), JobsModule, StorageModule],
  controllers: [PatientImportsController],
  providers: [
    PatientImportsService,
    PatientImportJobs,
    PrismaPatientImportRepository,
    TokenService,
    TenantContextInterceptor,
    {
      // SEC-046: lecturas de ficheros de importación a la vez (réplica y
      // clínica). Se toman con el cuerpo ya recibido: los plazos de
      // recepción son los del semáforo de subidas (StorageModule, DX-259).
      provide: IMPORT_READ_SLOTS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): UploadSlots => {
        const { perReplica, perClinic } = loadImportReadConcurrency((key) =>
          config.get<string>(key),
        );
        return new UploadSlots(perReplica, DEFAULT_UPLOAD_TIMEOUTS, perClinic);
      },
    },
    ImportReadSlotInterceptor,
  ],
})
export class PatientImportsModule {}
