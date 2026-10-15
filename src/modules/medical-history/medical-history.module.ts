import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MedicalHistoryController } from './presentation/medical-history.controller';
import { GetMedicalHistoryUseCase } from './application/use-cases/get-medical-history.use-case';
import { SaveMedicalHistoryUseCase } from './application/use-cases/save-medical-history.use-case';
import { MEDICAL_HISTORY_REPOSITORY } from './domain/ports/medical-history-repository.port';
import { PrismaMedicalHistoryRepository } from './infrastructure/repositories/prisma-medical-history.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PatientsModule } from '../patients/patients.module';

@Module({
  // JwtModule.register({}) mirrors PatientsModule/DentalCatalogModule:
  // JwtAuthGuard depends on TokenService, which depends on JwtService — must
  // be available here since the guard is applied on this module's controller.
  // PatientsModule exporta PATIENT_REPOSITORY: el use-case de alta valida que el
  // paciente de la ruta sea de esta clínica antes de insertar (SEC-004).
  imports: [JwtModule.register({}), PatientsModule],
  controllers: [MedicalHistoryController],
  providers: [
    GetMedicalHistoryUseCase,
    SaveMedicalHistoryUseCase,
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on MedicalHistoryController.
    TenantContextInterceptor,
    {
      provide: MEDICAL_HISTORY_REPOSITORY,
      useClass: PrismaMedicalHistoryRepository,
    },
  ],
})
export class MedicalHistoryModule {}
