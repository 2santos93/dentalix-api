import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PatientSourcesUseCases } from './application/patient-sources.use-cases';
import { PATIENT_SOURCE_REPOSITORY } from './domain/patient-source-repository.port';
import { PrismaPatientSourceRepository } from './infrastructure/prisma-patient-source.repository';
import {
  PatientAcquisitionController,
  PatientSourcesController,
} from './presentation/patient-sources.controller';

/**
 * «¿Cómo nos conoció?» (DX-172): el catálogo de fuentes de captación de la
 * clínica y la captación de un paciente en su ficha. El alta y la edición del
 * paciente fijan la fuente desde el módulo de pacientes
 * (`patients/infrastructure/patient-acquisition-in-tx.ts`); el informe vive
 * en Reportes.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [PatientSourcesController, PatientAcquisitionController],
  providers: [
    PatientSourcesUseCases,
    TokenService,
    TenantContextInterceptor,
    {
      provide: PATIENT_SOURCE_REPOSITORY,
      useClass: PrismaPatientSourceRepository,
    },
  ],
})
export class PatientSourcesModule {}
