import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import {
  DismissDuplicatePairUseCase,
  ListDuplicatePatientsUseCase,
  ListMergeLeftoversUseCase,
  MergePatientsUseCase,
  MoveMergeLeftoversUseCase,
  PATIENT_MERGE_CLOCK,
  PreviewPatientMergeUseCase,
} from './application/patient-merge.use-cases';
import { PATIENT_MERGE_REPOSITORY } from './domain/patient-merge-repository.port';
import { PrismaPatientMergeRepository } from './infrastructure/prisma-patient-merge.repository';
import { PatientDuplicatesController } from './presentation/patient-duplicates.controller';

/**
 * DX-266: pacientes posiblemente duplicados y fusión segura. Módulo propio:
 * no importa `PatientsModule` (usa sus helpers de infraestructura sin DI) y la
 * reasignación la hace la BD (`dx_merge_patients`).
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [PatientDuplicatesController],
  providers: [
    ListDuplicatePatientsUseCase,
    DismissDuplicatePairUseCase,
    PreviewPatientMergeUseCase,
    MergePatientsUseCase,
    ListMergeLeftoversUseCase,
    MoveMergeLeftoversUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: PATIENT_MERGE_CLOCK, useValue: () => new Date() },
    {
      provide: PATIENT_MERGE_REPOSITORY,
      useClass: PrismaPatientMergeRepository,
    },
  ],
})
export class PatientMergeModule {}
