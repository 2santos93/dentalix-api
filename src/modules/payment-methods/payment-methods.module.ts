import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import {
  CreatePaymentAdjustmentUseCase,
  CreatePaymentMethodUseCase,
  ListPaymentMethodsUseCase,
  UpdatePaymentAdjustmentUseCase,
  UpdatePaymentMethodUseCase,
} from './application/payment-methods.use-cases';
import { PAYMENT_METHOD_REPOSITORY } from './domain/ports/payment-method-repository.port';
import { PrismaPaymentMethodRepository } from './infrastructure/prisma-payment-method.repository';
import { PaymentMethodsController } from './presentation/payment-methods.controller';
import {
  ListPaymentMethodInstructionsUseCase,
  RemovePaymentMethodInstructionsUseCase,
  SavePaymentMethodInstructionsUseCase,
} from './application/payment-method-instructions.use-cases';
import { PAYMENT_METHOD_INSTRUCTION_REPOSITORY } from './domain/ports/payment-method-instruction-repository.port';
import { PrismaPaymentMethodInstructionRepository } from './infrastructure/prisma-payment-method-instruction.repository';

/**
 * Medios de pago de la clínica (DX-377). Exporta el repositorio para que el
 * alta del abono resuelva «¿este medio es de ESTA clínica, está activo y pide
 * referencia?» sin re-implementarlo.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [PaymentMethodsController],
  providers: [
    ListPaymentMethodsUseCase,
    CreatePaymentMethodUseCase,
    UpdatePaymentMethodUseCase,
    CreatePaymentAdjustmentUseCase,
    UpdatePaymentAdjustmentUseCase,
    ListPaymentMethodInstructionsUseCase,
    SavePaymentMethodInstructionsUseCase,
    RemovePaymentMethodInstructionsUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: PAYMENT_METHOD_REPOSITORY,
      useClass: PrismaPaymentMethodRepository,
    },
    {
      provide: PAYMENT_METHOD_INSTRUCTION_REPOSITORY,
      useClass: PrismaPaymentMethodInstructionRepository,
    },
  ],
  // DX-569: también los datos para pagar (el enlace de pago los muestra).
  exports: [PAYMENT_METHOD_REPOSITORY, PAYMENT_METHOD_INSTRUCTION_REPOSITORY],
})
export class PaymentMethodsModule {}
