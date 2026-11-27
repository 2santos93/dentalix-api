import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PatientsModule } from '../patients/patients.module';
import {
  ComparePerioExamsUseCase,
  CreatePerioExamUseCase,
  DeletePerioExamUseCase,
  FinalizePerioExamUseCase,
  GetPerioExamUseCase,
  GetPerioSettingsUseCase,
  ListPerioExamsUseCase,
  PERIO_CLOCK,
  SavePerioMeasuresUseCase,
  UpdatePerioNotesUseCase,
  UpdatePerioSettingsUseCase,
} from './application/use-cases/perio-exams.use-cases';
import { PERIO_EXAM_REPOSITORY } from './domain/ports/perio-exam-repository.port';
import { PrismaPerioExamRepository } from './infrastructure/repositories/prisma-perio-exam.repository';
import {
  PerioExamsController,
  PerioSettingsController,
} from './presentation/perio-exams.controller';

/**
 * Periodontograma con histórico (DX-007). PatientsModule exporta
 * PATIENT_REPOSITORY para el 404 de "paciente de otra clínica".
 */
@Module({
  imports: [JwtModule.register({}), PatientsModule],
  controllers: [PerioExamsController, PerioSettingsController],
  providers: [
    ListPerioExamsUseCase,
    CreatePerioExamUseCase,
    GetPerioExamUseCase,
    SavePerioMeasuresUseCase,
    FinalizePerioExamUseCase,
    DeletePerioExamUseCase,
    UpdatePerioNotesUseCase,
    ComparePerioExamsUseCase,
    GetPerioSettingsUseCase,
    UpdatePerioSettingsUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: PERIO_CLOCK, useValue: () => new Date() },
    { provide: PERIO_EXAM_REPOSITORY, useClass: PrismaPerioExamRepository },
  ],
})
export class PeriodontalModule {}
