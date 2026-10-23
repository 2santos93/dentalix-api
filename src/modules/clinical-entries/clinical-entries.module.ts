import { GetBatchRdaReadinessUseCase } from './application/use-cases/get-batch-rda-readiness.use-case';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ClinicalEntriesController } from './presentation/clinical-entries.controller';
import { ClinicalEntryRdaController } from './presentation/clinical-entry-rda.controller';
import { GetRdaReadinessUseCase } from './application/use-cases/get-rda-readiness.use-case';
import { CreateClinicalEntryUseCase } from './application/use-cases/create-clinical-entry.use-case';
import { ListClinicalEntriesUseCase } from './application/use-cases/list-clinical-entries.use-case';
import { CLINICAL_ENTRY_REPOSITORY } from './domain/ports/clinical-entry-repository.port';
import { PrismaClinicalEntryRepository } from './infrastructure/repositories/prisma-clinical-entry.repository';
import { CreateClinicalEntryAddendumUseCase } from './application/use-cases/create-clinical-entry-addendum.use-case';
import { ListClinicalEntryAddendaUseCase } from './application/use-cases/list-clinical-entry-addenda.use-case';
import { CLINICAL_ENTRY_ADDENDUM_REPOSITORY } from './domain/ports/clinical-entry-addendum-repository.port';
import { PrismaClinicalEntryAddendumRepository } from './infrastructure/repositories/prisma-clinical-entry-addendum.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PatientsModule } from '../patients/patients.module';
import { ClinicalNoteTemplatesModule } from '../clinical-note-templates/clinical-note-templates.module';

@Module({
  // JwtModule.register({}) mirrors PatientsModule/MedicalHistoryModule:
  // JwtAuthGuard depends on TokenService, which depends on JwtService — must
  // be available here since the guard is applied on this module's controller.
  // PatientsModule exporta PATIENT_REPOSITORY: el use-case de alta valida que el
  // paciente de la ruta sea de esta clínica antes de insertar (SEC-004).
  // DX-170: ClinicalNoteTemplatesModule exporta su repositorio: el alta valida
  // la plantilla (de esta clínica y activa) y compone el texto.
  imports: [
    JwtModule.register({}),
    PatientsModule,
    ClinicalNoteTemplatesModule,
  ],
  controllers: [ClinicalEntriesController, ClinicalEntryRdaController],
  providers: [
    CreateClinicalEntryUseCase,
    ListClinicalEntriesUseCase,
    CreateClinicalEntryAddendumUseCase,
    ListClinicalEntryAddendaUseCase,
    // DX-212: datos del RDA que faltan en una atención.
    GetRdaReadinessUseCase,
    GetBatchRdaReadinessUseCase,
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on ClinicalEntriesController.
    TenantContextInterceptor,
    {
      provide: CLINICAL_ENTRY_REPOSITORY,
      useClass: PrismaClinicalEntryRepository,
    },
    {
      provide: CLINICAL_ENTRY_ADDENDUM_REPOSITORY,
      useClass: PrismaClinicalEntryAddendumRepository,
    },
  ],
})
export class ClinicalEntriesModule {}
