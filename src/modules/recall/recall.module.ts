import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import {
  ClearPhoneReviewUseCase,
  CreateDefaultRecallUseCase,
  CreateRecallContactUseCase,
  CreateRecallContactsBatchUseCase,
  GetPatientRecallsUseCase,
  ListRecallSettingsUseCase,
  UpdateRecallSettingsUseCase,
  ListDueRecallsUseCase,
  ListRecallTypesUseCase,
  ListUnconfiguredRecallsUseCase,
  RECALL_CLOCK,
  SetPatientRecallUseCase,
} from './application/use-cases/recall.use-cases';
import {
  CreateRecallTypeUseCase,
  RetireRecallTypeUseCase,
  SetRecallTypeTriggersUseCase,
  UpdateRecallTypeUseCase,
} from './application/use-cases/recall-types.use-cases';
import { RECALL_REPOSITORY } from './domain/ports/recall-repository.port';
import { PrismaRecallRepository } from './infrastructure/prisma-recall.repository';
import {
  PatientPhoneReviewController,
  PatientRecallsController,
  RecallController,
  RecallSettingsController,
  RecallTypesController,
} from './presentation/recall.controller';

/**
 * Recall (DX-015): recall por paciente y tipo, lista de llamada de los
 * vencidos sin cita y registro de contactos. DX-015-bis: tipos por clínica con
 * sus procedimientos disparadores (`/recall-types`, CRUD solo ADMIN); el DONE
 * de uno mueve el reloj desde el repositorio de planes
 * (`recall-from-procedure.ts`) y aplica la exclusión entre tipos del mismo
 * grupo (`recall-exclusion.ts`). Exporta `ListDueRecallsUseCase`
 * para el recuento de «Mi día» (DX-503). DX-465: el contacto es el intento y
 * deja el estado del ciclo (ocultar N días, «Llamar luego», tope por sede,
 * lote, teléfono por revisar); los escritores de citas cierran el ciclo con
 * `recall-from-appointment.ts`. DX-391 (avisos automáticos) se apoya en estas
 * tablas.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [
    RecallController,
    PatientRecallsController,
    RecallTypesController,
    RecallSettingsController,
    PatientPhoneReviewController,
  ],
  providers: [
    ListDueRecallsUseCase,
    ListUnconfiguredRecallsUseCase,
    ListRecallTypesUseCase,
    GetPatientRecallsUseCase,
    SetPatientRecallUseCase,
    CreateDefaultRecallUseCase,
    CreateRecallContactUseCase,
    CreateRecallContactsBatchUseCase,
    ListRecallSettingsUseCase,
    UpdateRecallSettingsUseCase,
    ClearPhoneReviewUseCase,
    CreateRecallTypeUseCase,
    UpdateRecallTypeUseCase,
    RetireRecallTypeUseCase,
    SetRecallTypeTriggersUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: RECALL_REPOSITORY, useClass: PrismaRecallRepository },
    { provide: RECALL_CLOCK, useValue: () => new Date() },
  ],
  exports: [ListDueRecallsUseCase],
})
export class RecallModule {}
