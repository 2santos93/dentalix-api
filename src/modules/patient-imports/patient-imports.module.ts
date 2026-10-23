import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { JobsModule } from '../jobs/jobs.module';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
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
  ],
})
export class PatientImportsModule {}
