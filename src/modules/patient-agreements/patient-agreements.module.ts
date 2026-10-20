import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { AgreementsModule } from '../agreements/agreements.module';
import { PatientCoveragesModule } from '../patient-coverages/patient-coverages.module';
import { PatientAgreementFlags } from './application/patient-agreement-flags';
import {
  AssignPatientAgreementUseCase,
  GetPatientAgreementUseCase,
  PATIENT_AGREEMENTS_CLOCK,
  RemovePatientAgreementUseCase,
} from './application/use-cases/patient-agreements.use-cases';
import { PATIENT_AGREEMENT_REPOSITORY } from './domain/ports/patient-agreement-repository.port';
import { PrismaPatientAgreementRepository } from './infrastructure/repositories/prisma-patient-agreement.repository';
import { PatientAgreementsController } from './presentation/patient-agreements.controller';

/**
 * Convenio del paciente (DX-105): sub-recurso de la ficha, en un módulo propio.
 * No importa `PatientsModule` (será `PatientsModule` quien importe este, y un
 * ciclo no cabe): el paciente se comprueba con su propia consulta bajo RLS. El
 * convenio sale de `AgreementsModule` y la cobertura de `PatientCoveragesModule`.
 */
@Module({
  imports: [JwtModule.register({}), AgreementsModule, PatientCoveragesModule],
  controllers: [PatientAgreementsController],
  providers: [
    GetPatientAgreementUseCase,
    AssignPatientAgreementUseCase,
    RemovePatientAgreementUseCase,
    PatientAgreementFlags,
    TokenService,
    TenantContextInterceptor,
    { provide: PATIENT_AGREEMENTS_CLOCK, useValue: () => new Date() },
    {
      provide: PATIENT_AGREEMENT_REPOSITORY,
      useClass: PrismaPatientAgreementRepository,
    },
  ],
  // Resumen para la ficha; el repositorio, para la resolución de precios del plan.
  exports: [PatientAgreementFlags, PATIENT_AGREEMENT_REPOSITORY],
})
export class PatientAgreementsModule {}
