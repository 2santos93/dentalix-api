import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PatientsController } from './presentation/patients.controller';
import { CreatePatientUseCase } from './application/use-cases/create-patient.use-case';
import { ListPatientsUseCase } from './application/use-cases/list-patients.use-case';
import { CountPatientsUseCase } from './application/use-cases/count-patients.use-case';
import { GetPatientUseCase } from './application/use-cases/get-patient.use-case';
import { UpdatePatientUseCase } from './application/use-cases/update-patient.use-case';
import {
  ArchivePatientUseCase,
  ListRetentionExpiringUseCase,
  PartiallySuppressPatientUseCase,
  RETENTION_CLOCK,
  SetRetentionExtensionUseCase,
} from './application/use-cases/retention.use-cases';
import { PATIENT_REPOSITORY } from './domain/ports/patient-repository.port';
import { PrismaPatientRepository } from './infrastructure/repositories/prisma-patient.repository';
import { REFERENCE_LOOKUP } from './domain/ports/reference-lookup.port';
import { PrismaReferenceLookup } from './infrastructure/adapters/prisma-reference-lookup.adapter';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';

@Module({
  // JwtModule.register({}) mirrors AuthModule: JwtAuthGuard depends on
  // TokenService, which depends on JwtService — must be available here since
  // the guard is applied on this module's controller.
  imports: [JwtModule.register({})],
  controllers: [PatientsController],
  providers: [
    CreatePatientUseCase,
    ListPatientsUseCase,
    CountPatientsUseCase,
    GetPatientUseCase,
    UpdatePatientUseCase,
    ArchivePatientUseCase,
    SetRetentionExtensionUseCase,
    PartiallySuppressPatientUseCase,
    ListRetentionExpiringUseCase,
    { provide: RETENTION_CLOCK, useValue: () => new Date() },
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on PatientsController.
    TenantContextInterceptor,
    { provide: PATIENT_REPOSITORY, useClass: PrismaPatientRepository },
    { provide: REFERENCE_LOOKUP, useClass: PrismaReferenceLookup },
  ],
  // CountPatientsUseCase exportado para el `patientCount` del dashboard: un
  // COUNT, no una página de pacientes (DX-043, DB-008).
  // PATIENT_REPOSITORY exportado (aditivo) para que CreateAppointmentUseCase
  // valide que el paciente sea de ESTA clínica — mismo patrón cross-module que
  // DentalCatalogModule exportando su repo.
  exports: [CountPatientsUseCase, PATIENT_REPOSITORY],
})
export class PatientsModule {}
