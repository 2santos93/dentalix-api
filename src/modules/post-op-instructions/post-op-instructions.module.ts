import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { EmailModule } from '../notifications/email/email.module';
import { PatientsModule } from '../patients/patients.module';
import { POSTOP_CLOCK } from './application/post-op-clock';
import {
  CreatePostOpTemplateUseCase,
  ListPostOpTemplatesUseCase,
  LoadSamplePostOpTemplatesUseCase,
  UpdatePostOpTemplateUseCase,
} from './application/use-cases/post-op-templates.use-cases';
import { POST_OP_TEMPLATE_REPOSITORY } from './domain/ports/post-op-template-repository.port';
import { PrismaPostOpTemplateRepository } from './infrastructure/repositories/prisma-post-op-template.repository';
import { PostOpTemplatesController } from './presentation/post-op-templates.controller';

/**
 * Indicaciones postoperatorias (DX-222): plantillas por clínica con versión y
 * vínculos a procedimientos y tipos de cita. PatientsModule (destinatario y
 * aislamiento por paciente) y EmailModule (envío por email) sirven a las
 * entregas; el reloj `POSTOP_CLOCK` fija la caducidad de los enlaces.
 */
@Module({
  imports: [JwtModule.register({}), PatientsModule, EmailModule],
  controllers: [PostOpTemplatesController],
  providers: [
    ListPostOpTemplatesUseCase,
    CreatePostOpTemplateUseCase,
    UpdatePostOpTemplateUseCase,
    LoadSamplePostOpTemplatesUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: POSTOP_CLOCK, useValue: () => new Date() },
    {
      provide: POST_OP_TEMPLATE_REPOSITORY,
      useClass: PrismaPostOpTemplateRepository,
    },
  ],
  exports: [LoadSamplePostOpTemplatesUseCase],
})
export class PostOpInstructionsModule {}
