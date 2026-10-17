import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { JobsModule } from '../jobs/jobs.module';
import { COLLECTIONS_CLOCK } from './application/collections-clock';
import { CollectionsJobs } from './application/collections-jobs';
import { PatientBalanceFlags } from './application/patient-balance-flags';
import { SettlePaymentPromises } from './application/settle-payment-promises';
import {
  CreateCollectionNoteUseCase,
  CreatePaymentPromiseUseCase,
  GetPatientCollectionsUseCase,
} from './application/use-cases/collections.use-cases';
import { COLLECTIONS_REPOSITORY } from './domain/ports/collections-repository.port';
import { PrismaCollectionsRepository } from './infrastructure/prisma-collections.repository';
import { CollectionsController } from './presentation/collections.controller';

/**
 * Cobranza (DX-150): gestiones y compromisos de pago, su cierre (barrido en la
 * cola de DX-085 y al registrar un abono) y la marca «Saldo vencido» por lote
 * que usan la agenda y la ficha. Exporta `PatientBalanceFlags` (agenda y
 * ficha) y `SettlePaymentPromises` (abonos).
 */
@Module({
  imports: [JwtModule.register({}), JobsModule],
  controllers: [CollectionsController],
  providers: [
    CreateCollectionNoteUseCase,
    CreatePaymentPromiseUseCase,
    GetPatientCollectionsUseCase,
    SettlePaymentPromises,
    PatientBalanceFlags,
    CollectionsJobs,
    TokenService,
    TenantContextInterceptor,
    { provide: COLLECTIONS_REPOSITORY, useClass: PrismaCollectionsRepository },
    { provide: COLLECTIONS_CLOCK, useValue: () => new Date() },
  ],
  exports: [PatientBalanceFlags, SettlePaymentPromises],
})
export class CollectionsModule {}
