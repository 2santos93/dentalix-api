import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PayersController } from './presentation/payers.controller';
import {
  CreatePayerUseCase,
  DeletePayerUseCase,
  ListPayersUseCase,
  UpdatePayerUseCase,
} from './application/use-cases/payers.use-cases';
import { PAYER_REPOSITORY } from './domain/ports/payer-repository.port';
import { PrismaPayerRepository } from './infrastructure/repositories/prisma-payer.repository';

/**
 * Catálogo de pagadores por clínica (DX-153). Exporta el repositorio para que
 * las coberturas del paciente resuelvan «¿este pagador es de ESTA clínica y
 * está activo?» sin re-implementarlo.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [PayersController],
  providers: [
    ListPayersUseCase,
    CreatePayerUseCase,
    UpdatePayerUseCase,
    DeletePayerUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: PAYER_REPOSITORY, useClass: PrismaPayerRepository },
  ],
  exports: [PAYER_REPOSITORY],
})
export class PayersModule {}
