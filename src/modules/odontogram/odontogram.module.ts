import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { OdontogramController } from './presentation/odontogram.controller';
import { AddToothRecordUseCase } from './application/use-cases/add-tooth-record.use-case';
import { GetOdontogramUseCase } from './application/use-cases/get-odontogram.use-case';
import { GetToothTimelineUseCase } from './application/use-cases/get-tooth-timeline.use-case';
import { TOOTH_RECORD_REPOSITORY } from './domain/ports/tooth-record-repository.port';
import { PrismaToothRecordRepository } from './infrastructure/repositories/prisma-tooth-record.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';

@Module({
  // JwtModule.register({}) mirrors ClinicalEntriesModule/PatientsModule:
  // JwtAuthGuard depends on TokenService, which depends on JwtService — must
  // be available here since the guard is applied on this module's controller.
  imports: [JwtModule.register({})],
  controllers: [OdontogramController],
  providers: [
    AddToothRecordUseCase,
    GetOdontogramUseCase,
    GetToothTimelineUseCase,
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on OdontogramController.
    TenantContextInterceptor,
    {
      provide: TOOTH_RECORD_REPOSITORY,
      useClass: PrismaToothRecordRepository,
    },
  ],
  // Exported (additive) so TreatmentPlansModule can inject TOOTH_RECORD_REPOSITORY
  // to mirror a plan item marked DONE into the odontogram (Pieza B) — same
  // cross-module DI pattern as DentalCatalogModule exporting its repository.
  exports: [TOOTH_RECORD_REPOSITORY],
})
export class OdontogramModule {}
