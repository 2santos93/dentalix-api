import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
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
import { PRESCRIPTION_REPOSITORY } from './domain/ports/prescription-repository.port';
import { PRESCRIPTION_TEMPLATE_REPOSITORY } from './domain/ports/prescription-template-repository.port';
import { PrismaPrescriptionRepository } from './infrastructure/repositories/prisma-prescription.repository';
import { PrismaPrescriptionTemplateRepository } from './infrastructure/repositories/prisma-prescription-template.repository';
import {
  PatientPrescriptionsController,
  PrescriptionsController,
} from './presentation/prescriptions.controller';
import { PrescriptionTemplatesController } from './presentation/prescription-templates.controller';

/**
 * Recetas (DX-013): emisión inmutable con campos legales por país de la sede
 * (CO/ES), avisos de seguridad contra la anamnesis (DX-300: alergias,
 * interacciones, embarazo, antirresortivos, dosis infantil), anulación con
 * motivo y plantillas por clínica.
 */
@Module({
  imports: [JwtModule.register({})],
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
    TokenService,
    TenantContextInterceptor,
    { provide: PRESCRIPTION_CLOCK, useValue: () => new Date() },
    {
      provide: PRESCRIPTION_REPOSITORY,
      useClass: PrismaPrescriptionRepository,
    },
    {
      provide: PRESCRIPTION_TEMPLATE_REPOSITORY,
      useClass: PrismaPrescriptionTemplateRepository,
    },
  ],
})
export class PrescriptionsModule {}
