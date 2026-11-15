import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { TreatmentPlanTemplatesController } from './presentation/treatment-plan-templates.controller';
import {
  CreatePlanTemplateUseCase,
  GetPlanTemplateUseCase,
  ListPlanTemplatesUseCase,
  UpdatePlanTemplateUseCase,
} from './application/use-cases/treatment-plan-templates.use-cases';
import { TREATMENT_PLAN_TEMPLATE_REPOSITORY } from './domain/ports/treatment-plan-template-repository.port';
import { PrismaTreatmentPlanTemplateRepository } from './infrastructure/repositories/prisma-treatment-plan-template.repository';

/**
 * Plantillas de plan de tratamiento (DX-559). Exporta el repositorio para que
 * TreatmentPlansModule lea la plantilla al aplicarla a un plan
 * (`POST /treatment-plans/:id/apply-template`).
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [TreatmentPlanTemplatesController],
  providers: [
    ListPlanTemplatesUseCase,
    GetPlanTemplateUseCase,
    CreatePlanTemplateUseCase,
    UpdatePlanTemplateUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: TREATMENT_PLAN_TEMPLATE_REPOSITORY,
      useClass: PrismaTreatmentPlanTemplateRepository,
    },
  ],
  exports: [TREATMENT_PLAN_TEMPLATE_REPOSITORY],
})
export class TreatmentPlanTemplatesModule {}
