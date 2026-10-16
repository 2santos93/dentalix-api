import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrivacyPoliciesController } from './presentation/privacy-policies.controller';
import { PatientDataConsentsController } from './presentation/patient-data-consents.controller';
import { GetPrivacyPoliciesUseCase } from './application/use-cases/get-privacy-policies.use-case';
import { PublishPrivacyPolicyUseCase } from './application/use-cases/publish-privacy-policy.use-case';
import { GetPatientDataConsentsUseCase } from './application/use-cases/get-patient-data-consents.use-case';
import { RecordDataConsentsUseCase } from './application/use-cases/record-data-consents.use-case';
import { PRIVACY_POLICY_REPOSITORY } from './domain/ports/privacy-policy-repository.port';
import { DATA_CONSENT_REPOSITORY } from './domain/ports/data-consent-repository.port';
import { PrismaPrivacyPolicyRepository } from './infrastructure/repositories/prisma-privacy-policy.repository';
import { PrismaDataConsentRepository } from './infrastructure/repositories/prisma-data-consent.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PatientsModule } from '../patients/patients.module';

// DX-037: autorización de tratamiento de datos (Ley 1581) versionada y con
// prueba. JwtModule + TokenService + TenantContextInterceptor: mismo cableado
// que MedicalHistoryModule. PatientsModule exporta PATIENT_REPOSITORY para
// validar que el paciente de la ruta sea de esta clínica (SEC-004).
@Module({
  imports: [JwtModule.register({}), PatientsModule],
  controllers: [PrivacyPoliciesController, PatientDataConsentsController],
  providers: [
    GetPrivacyPoliciesUseCase,
    PublishPrivacyPolicyUseCase,
    GetPatientDataConsentsUseCase,
    RecordDataConsentsUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: PRIVACY_POLICY_REPOSITORY,
      useClass: PrismaPrivacyPolicyRepository,
    },
    { provide: DATA_CONSENT_REPOSITORY, useClass: PrismaDataConsentRepository },
  ],
})
export class DataConsentsModule {}
