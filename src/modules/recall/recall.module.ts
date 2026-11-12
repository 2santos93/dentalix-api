import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import {
  CreateRecallContactUseCase,
  GetPatientRecallsUseCase,
  ListDueRecallsUseCase,
  ListRecallTypesUseCase,
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
  PatientRecallsController,
  RecallController,
  RecallTypesController,
} from './presentation/recall.controller';

/**
 * Recall (DX-015): recall por paciente y tipo, lista de llamada de los
 * vencidos sin cita y registro de contactos. DX-015-bis: tipos por clínica con
 * sus procedimientos disparadores (`/recall-types`, CRUD solo ADMIN); el DONE
 * de uno mueve el reloj desde el repositorio de planes
 * (`recall-from-procedure.ts`) y aplica la exclusión entre tipos del mismo
 * grupo (`recall-exclusion.ts`). Exporta `ListDueRecallsUseCase`
 * para el recuento de «Mi día» (DX-503). DX-465 (ocultar N días, tope de
 * intentos) y DX-391 (avisos automáticos) se apoyan en estas tablas.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [
    RecallController,
    PatientRecallsController,
    RecallTypesController,
  ],
  providers: [
    ListDueRecallsUseCase,
    ListRecallTypesUseCase,
    GetPatientRecallsUseCase,
    SetPatientRecallUseCase,
    CreateRecallContactUseCase,
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
