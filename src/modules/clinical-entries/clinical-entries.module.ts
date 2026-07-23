import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ClinicalEntriesController } from './presentation/clinical-entries.controller';
import { CreateClinicalEntryUseCase } from './application/use-cases/create-clinical-entry.use-case';
import { ListClinicalEntriesUseCase } from './application/use-cases/list-clinical-entries.use-case';
import { CLINICAL_ENTRY_REPOSITORY } from './domain/ports/clinical-entry-repository.port';
import { PrismaClinicalEntryRepository } from './infrastructure/repositories/prisma-clinical-entry.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';

@Module({
  // JwtModule.register({}) mirrors PatientsModule/MedicalHistoryModule:
  // JwtAuthGuard depends on TokenService, which depends on JwtService — must
  // be available here since the guard is applied on this module's controller.
  imports: [JwtModule.register({})],
  controllers: [ClinicalEntriesController],
  providers: [
    CreateClinicalEntryUseCase,
    ListClinicalEntriesUseCase,
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on ClinicalEntriesController.
    TenantContextInterceptor,
    {
      provide: CLINICAL_ENTRY_REPOSITORY,
      useClass: PrismaClinicalEntryRepository,
    },
  ],
})
export class ClinicalEntriesModule {}
