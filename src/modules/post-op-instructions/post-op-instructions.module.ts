import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { PublicTenantContextInterceptor } from '../../shared/tenancy/public-tenant-context.interceptor';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { EmailModule } from '../notifications/email/email.module';
import { PatientsModule } from '../patients/patients.module';
import { POSTOP_CLOCK } from './application/post-op-clock';
import {
  DeliverPostOpInstructionsUseCase,
  GetPatientPostOpDeliveryUseCase,
  GetPostOpSuggestionsUseCase,
  ListPatientPostOpDeliveriesUseCase,
} from './application/use-cases/post-op-deliveries.use-cases';
import {
  OutboxPostOpEmailSender,
  POSTOP_EMAIL_SENDER,
} from './application/postop-email';
import {
  GetPublicPostOpUseCase,
  MarkPublicPostOpOpenedUseCase,
} from './application/use-cases/public-post-op.use-cases';
import {
  CreatePostOpTemplateUseCase,
  ListPostOpTemplatesUseCase,
  LoadSamplePostOpTemplatesUseCase,
  UpdatePostOpTemplateUseCase,
} from './application/use-cases/post-op-templates.use-cases';
import { POST_OP_DELIVERY_REPOSITORY } from './domain/ports/post-op-delivery-repository.port';
import { POST_OP_TEMPLATE_REPOSITORY } from './domain/ports/post-op-template-repository.port';
import { PrismaPostOpDeliveryRepository } from './infrastructure/repositories/prisma-post-op-delivery.repository';
import { PrismaPostOpTemplateRepository } from './infrastructure/repositories/prisma-post-op-template.repository';
import { AppointmentPostOpController } from './presentation/appointment-post-op.controller';
import { PatientPostOpDeliveriesController } from './presentation/patient-post-op-deliveries.controller';
import { PostOpTemplatesController } from './presentation/post-op-templates.controller';
import { PublicPostOpInstructionsController } from './presentation/public-post-op-instructions.controller';

/**
 * Indicaciones postoperatorias (DX-222): plantillas por clínica con versión y
 * vínculos a procedimientos y tipos de cita, y entregas por cita (impresas,
 * por email o por enlace de WhatsApp) con el texto congelado. PatientsModule (destinatario y
 * aislamiento por paciente) y EmailModule (envío por email) sirven a las
 * entregas; el reloj `POSTOP_CLOCK` fija la caducidad de los enlaces, que el
 * paciente abre sin sesión en `public/post-op-instructions/:token`.
 */
@Module({
  imports: [JwtModule.register({}), PatientsModule, EmailModule],
  controllers: [
    PostOpTemplatesController,
    AppointmentPostOpController,
    PatientPostOpDeliveriesController,
    PublicPostOpInstructionsController,
  ],
  providers: [
    ListPostOpTemplatesUseCase,
    CreatePostOpTemplateUseCase,
    UpdatePostOpTemplateUseCase,
    LoadSamplePostOpTemplatesUseCase,
    GetPostOpSuggestionsUseCase,
    DeliverPostOpInstructionsUseCase,
    ListPatientPostOpDeliveriesUseCase,
    GetPatientPostOpDeliveryUseCase,
    GetPublicPostOpUseCase,
    MarkPublicPostOpOpenedUseCase,
    TokenService,
    TenantContextInterceptor,
    PublicTenantContextInterceptor,
    { provide: POSTOP_CLOCK, useValue: () => new Date() },
    {
      provide: POST_OP_TEMPLATE_REPOSITORY,
      useClass: PrismaPostOpTemplateRepository,
    },
    {
      provide: POST_OP_DELIVERY_REPOSITORY,
      useClass: PrismaPostOpDeliveryRepository,
    },
    { provide: POSTOP_EMAIL_SENDER, useClass: OutboxPostOpEmailSender },
  ],
  exports: [LoadSamplePostOpTemplatesUseCase],
})
export class PostOpInstructionsModule {}
