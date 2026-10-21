import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MedicalHistoryController } from './presentation/medical-history.controller';
import {
  AnamnesisSettingsController,
  PatientMedicalAlertsController,
} from './presentation/medical-alerts.controller';
import {
  MEDICAL_ALERTS_CLOCK,
  PatientMedicalAlertFlags,
} from './application/patient-medical-alert-flags';
import {
  ConfirmAnamnesisNoChangesUseCase,
  GetAnamnesisSettingsUseCase,
  GetPatientMedicalAlertsUseCase,
  UpdateAnamnesisSettingsUseCase,
} from './application/use-cases/medical-alerts.use-cases';
import { MEDICAL_ALERTS_REPOSITORY } from './domain/ports/medical-alerts-repository.port';
import { PrismaMedicalAlertsRepository } from './infrastructure/repositories/prisma-medical-alerts.repository';
import { GetMedicalHistoryUseCase } from './application/use-cases/get-medical-history.use-case';
import { SaveMedicalHistoryUseCase } from './application/use-cases/save-medical-history.use-case';
import { MEDICAL_HISTORY_REPOSITORY } from './domain/ports/medical-history-repository.port';
import { PrismaMedicalHistoryRepository } from './infrastructure/repositories/prisma-medical-history.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PatientsModule } from '../patients/patients.module';
// DX-247: zona de cada sede para evaluar la anamnesis por día civil.
import { LocationsModule } from '../locations/locations.module';

@Module({
  // JwtModule.register({}) mirrors PatientsModule/DentalCatalogModule:
  // JwtAuthGuard depends on TokenService, which depends on JwtService — must
  // be available here since the guard is applied on this module's controller.
  // PatientsModule exporta PATIENT_REPOSITORY: el use-case de alta valida que el
  // paciente de la ruta sea de esta clínica antes de insertar (SEC-004).
  imports: [JwtModule.register({}), PatientsModule, LocationsModule],
  controllers: [
    MedicalHistoryController,
    // DX-247: banderas del paciente y vigencia de la anamnesis.
    PatientMedicalAlertsController,
    AnamnesisSettingsController,
  ],
  providers: [
    GetMedicalHistoryUseCase,
    SaveMedicalHistoryUseCase,
    // DX-247: banderas por lote (agenda, «En clínica»), «Sin cambios hoy» y
    // vigencia de la clínica.
    PatientMedicalAlertFlags,
    GetPatientMedicalAlertsUseCase,
    ConfirmAnamnesisNoChangesUseCase,
    GetAnamnesisSettingsUseCase,
    UpdateAnamnesisSettingsUseCase,
    { provide: MEDICAL_ALERTS_CLOCK, useValue: () => new Date() },
    {
      provide: MEDICAL_ALERTS_REPOSITORY,
      useClass: PrismaMedicalAlertsRepository,
    },
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on MedicalHistoryController.
    TenantContextInterceptor,
    {
      provide: MEDICAL_HISTORY_REPOSITORY,
      useClass: PrismaMedicalHistoryRepository,
    },
  ],
  // DX-247: la agenda y el panel «En clínica» piden las banderas por lote.
  exports: [PatientMedicalAlertFlags],
})
export class MedicalHistoryModule {}
