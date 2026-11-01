import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import {
  CreateRecallContactUseCase,
  GetPatientRecallsUseCase,
  ListDueRecallsUseCase,
  RECALL_CLOCK,
  SetPatientRecallUseCase,
} from './application/use-cases/recall.use-cases';
import { RECALL_REPOSITORY } from './domain/ports/recall-repository.port';
import { PrismaRecallRepository } from './infrastructure/prisma-recall.repository';
import {
  PatientRecallsController,
  RecallController,
} from './presentation/recall.controller';

/**
 * Recall (DX-015): recall por paciente y tipo, lista de llamada de los
 * vencidos sin cita y registro de contactos. Exporta `ListDueRecallsUseCase`
 * para el recuento de «Mi día» (DX-503). DX-465 (ocultar N días, tope de
 * intentos) y DX-391 (avisos automáticos) se apoyan en estas tablas.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [RecallController, PatientRecallsController],
  providers: [
    ListDueRecallsUseCase,
    GetPatientRecallsUseCase,
    SetPatientRecallUseCase,
    CreateRecallContactUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: RECALL_REPOSITORY, useClass: PrismaRecallRepository },
    { provide: RECALL_CLOCK, useValue: () => new Date() },
  ],
  exports: [ListDueRecallsUseCase],
})
export class RecallModule {}
