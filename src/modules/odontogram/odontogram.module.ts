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
import { PatientsModule } from '../patients/patients.module';

@Module({
  // JwtModule.register({}) mirrors ClinicalEntriesModule/PatientsModule:
  // JwtAuthGuard depends on TokenService, which depends on JwtService — must
  // be available here since the guard is applied on this module's controller.
  // PatientsModule exporta PATIENT_REPOSITORY: el use-case de alta valida que el
  // paciente de la ruta sea de esta clínica antes de insertar (SEC-004).
  imports: [JwtModule.register({}), PatientsModule],
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
})
export class OdontogramModule {}
