import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { ClinicalEntriesModule } from '../clinical-entries/clinical-entries.module';
import { PatientsModule } from '../patients/patients.module';
import {
  OrthoCaseUseCases,
  OrthoFollowUpUseCase,
  OrthoSettingsUseCases,
  OrthoVisitUseCases,
} from './application/use-cases/ortho.use-cases';
import {
  ORTHO_CLOCK,
  ORTHO_REPOSITORY,
} from './domain/ports/ortho-repository.port';
import { PrismaOrthoRepository } from './infrastructure/prisma-ortho.repository';
import {
  OrthoController,
  PatientOrthoController,
} from './presentation/ortho.controller';

/**
 * Ortodoncia (DX-190): caso por paciente (uno activo), control estructurado
 * inalterable que cuelga de una evolución (ClinicalEntriesModule exporta su
 * alta: mismas reglas y misma transacción) y lista de seguimiento de la
 * clínica (atrasados, sin próxima cita, no-show).
 */
@Module({
  imports: [JwtModule.register({}), PatientsModule, ClinicalEntriesModule],
  controllers: [PatientOrthoController, OrthoController],
  providers: [
    OrthoSettingsUseCases,
    OrthoCaseUseCases,
    OrthoVisitUseCases,
    OrthoFollowUpUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: ORTHO_CLOCK, useValue: () => new Date() },
    { provide: ORTHO_REPOSITORY, useClass: PrismaOrthoRepository },
  ],
})
export class OrthodonticsModule {}
