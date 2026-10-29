import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { DocumentTypeNamesModule } from '../document-type-names/document-type-names.module';
import {
  CheckPrescriptionSafetyUseCase,
  GetPrescriptionIssuerUseCase,
  GetPrescriptionUseCase,
  IssuePrescriptionUseCase,
  ListPatientPrescriptionsUseCase,
  PRESCRIPTION_CLOCK,
  VoidPrescriptionUseCase,
} from './application/use-cases/prescriptions.use-cases';
import {
  CreatePrescriptionTemplateUseCase,
  DeletePrescriptionTemplateUseCase,
  ListPrescriptionTemplatesUseCase,
  UpdatePrescriptionTemplateUseCase,
} from './application/use-cases/prescription-templates.use-cases';
import {
  GetPrescriptionSettingsUseCase,
  UpdatePrescriptionSettingsUseCase,
} from './application/use-cases/prescription-settings.use-cases';
import { PRESCRIPTION_REPOSITORY } from './domain/ports/prescription-repository.port';
import { PRESCRIPTION_SETTINGS_REPOSITORY } from './domain/ports/prescription-settings-repository.port';
import { PRESCRIPTION_TEMPLATE_REPOSITORY } from './domain/ports/prescription-template-repository.port';
import { PrismaPrescriptionRepository } from './infrastructure/repositories/prisma-prescription.repository';
import { PrismaPrescriptionTemplateRepository } from './infrastructure/repositories/prisma-prescription-template.repository';
import { PrismaPrescriptionSettingsRepository } from './infrastructure/repositories/prisma-prescription-settings.repository';
import {
  PatientPrescriptionsController,
  PrescriptionsController,
} from './presentation/prescriptions.controller';
import { PrescriptionTemplatesController } from './presentation/prescription-templates.controller';

/**
 * Recetas (DX-013): emisión inmutable de una receta única (DX-324: sin reglas
 * por país; lo que exige e imprime lo deciden los ajustes de la clínica),
 * avisos de seguridad contra la anamnesis (DX-300: alergias, interacciones,
 * embarazo, antirresortivos, dosis infantil), anulación con motivo,
 * plantillas y ajustes de la receta por clínica.
 */
@Module({
  imports: [JwtModule.register({}), DocumentTypeNamesModule],
  controllers: [
    PatientPrescriptionsController,
    PrescriptionsController,
    PrescriptionTemplatesController,
  ],
  providers: [
    GetPrescriptionIssuerUseCase,
    CheckPrescriptionSafetyUseCase,
    IssuePrescriptionUseCase,
    ListPatientPrescriptionsUseCase,
    GetPrescriptionUseCase,
    VoidPrescriptionUseCase,
    ListPrescriptionTemplatesUseCase,
    CreatePrescriptionTemplateUseCase,
    UpdatePrescriptionTemplateUseCase,
    DeletePrescriptionTemplateUseCase,
    GetPrescriptionSettingsUseCase,
    UpdatePrescriptionSettingsUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: PRESCRIPTION_CLOCK, useValue: () => new Date() },
    {
      provide: PRESCRIPTION_REPOSITORY,
      useClass: PrismaPrescriptionRepository,
    },
    {
      provide: PRESCRIPTION_SETTINGS_REPOSITORY,
      useClass: PrismaPrescriptionSettingsRepository,
    },
    {
      provide: PRESCRIPTION_TEMPLATE_REPOSITORY,
      useClass: PrismaPrescriptionTemplateRepository,
    },
  ],
})
export class PrescriptionsModule {}
