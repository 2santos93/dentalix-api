import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { ClinicalNoteTemplatesController } from './presentation/clinical-note-templates.controller';
import {
  CreateNoteTemplateUseCase,
  ListNoteTemplatesUseCase,
  LoadSampleNoteTemplatesUseCase,
  UpdateNoteTemplateUseCase,
} from './application/use-cases/clinical-note-templates.use-cases';
import { CLINICAL_NOTE_TEMPLATE_REPOSITORY } from './domain/ports/clinical-note-template-repository.port';
import { PrismaClinicalNoteTemplateRepository } from './infrastructure/repositories/prisma-clinical-note-template.repository';

/**
 * Plantillas de evolución (DX-170). Exporta el repositorio para que
 * ClinicalEntriesModule resuelva «¿esta plantilla es de ESTA clínica y está
 * activa?» y componga el texto al registrar la evolución; y el caso de uso de
 * los ejemplos, para la clínica demo.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [ClinicalNoteTemplatesController],
  providers: [
    ListNoteTemplatesUseCase,
    CreateNoteTemplateUseCase,
    UpdateNoteTemplateUseCase,
    LoadSampleNoteTemplatesUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: CLINICAL_NOTE_TEMPLATE_REPOSITORY,
      useClass: PrismaClinicalNoteTemplateRepository,
    },
  ],
  exports: [CLINICAL_NOTE_TEMPLATE_REPOSITORY, LoadSampleNoteTemplatesUseCase],
})
export class ClinicalNoteTemplatesModule {}
