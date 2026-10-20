import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PayersModule } from '../payers/payers.module';
import { PatientCoveragesController } from './presentation/patient-coverages.controller';
import {
  COVERAGES_CLOCK,
  CreatePatientCoverageUseCase,
  DeletePatientCoverageUseCase,
  ListPatientCoveragesUseCase,
  UpdatePatientCoverageUseCase,
} from './application/use-cases/patient-coverages.use-cases';
import { PatientCoverageFlags } from './application/patient-coverage-flags';
import { PATIENT_COVERAGE_REPOSITORY } from './domain/ports/patient-coverage-repository.port';
import { PrismaPatientCoverageRepository } from './infrastructure/repositories/prisma-patient-coverage.repository';

/**
 * Coberturas del paciente (DX-153): sub-recurso de la ficha, en un módulo
 * propio. No importa `PatientsModule` (será `PatientsModule` quien importe
 * este, y un ciclo no cabe): el paciente se comprueba con su propia consulta
 * bajo RLS. El pagador sale del catálogo de `PayersModule`.
 */
@Module({
  imports: [JwtModule.register({}), PayersModule],
  controllers: [PatientCoveragesController],
  providers: [
    ListPatientCoveragesUseCase,
    CreatePatientCoverageUseCase,
    UpdatePatientCoverageUseCase,
    DeletePatientCoverageUseCase,
    PatientCoverageFlags,
    TokenService,
    TenantContextInterceptor,
    { provide: COVERAGES_CLOCK, useValue: () => new Date() },
    {
      provide: PATIENT_COVERAGE_REPOSITORY,
      useClass: PrismaPatientCoverageRepository,
    },
  ],
  // Resumen por lote para la ficha, el listado de pacientes y la agenda.
  exports: [PatientCoverageFlags],
})
export class PatientCoveragesModule {}
