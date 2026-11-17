import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ExpensesModule } from '../expenses/expenses.module';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { CommissionPaymentUseCases } from './application/commission-payment.use-cases';
import { CommissionReceiptPublicUseCases } from './application/commission-receipt-public.use-cases';
import { CommissionUseCases } from './application/commission.use-cases';
import { COMMISSION_PAYMENT_REPOSITORY } from './domain/ports/commission-payment-repository.port';
import {
  COMMISSION_PDF_RENDERER,
  PdfkitCommissionPdfRenderer,
} from './infrastructure/commission-pdf.renderer';
import { PrismaCommissionPaymentRepository } from './infrastructure/prisma-commission-payment.repository';
import { CommissionPaymentsController } from './presentation/commission-payments.controller';
import { PublicCommissionReceiptsController } from './presentation/public-commission-receipts.controller';
import {
  COMMISSION_CLOCK,
  COMMISSION_REPOSITORY,
} from './domain/ports/commission-repository.port';
import { PrismaCommissionRepository } from './infrastructure/prisma-commission.repository';
import { CommissionsController } from './presentation/commissions.controller';

/**
 * Honorarios de odontólogos a porcentaje (DX-018): regla por profesional,
 * vista previa del período y liquidación congelada que fija el cierre
 * contable (DX-091). Atribución de DX-050 e imputaciones de DX-051.
 * DX-464: el pago de la liquidación (gasto de la sede, por ExpensesModule),
 * sus PDF y la conformidad del profesional por enlace público.
 */
@Module({
  imports: [JwtModule.register({}), ExpensesModule],
  controllers: [
    CommissionsController,
    CommissionPaymentsController,
    PublicCommissionReceiptsController,
  ],
  providers: [
    CommissionUseCases,
    CommissionPaymentUseCases,
    CommissionReceiptPublicUseCases,
    {
      provide: COMMISSION_PAYMENT_REPOSITORY,
      useClass: PrismaCommissionPaymentRepository,
    },
    {
      provide: COMMISSION_PDF_RENDERER,
      useFactory: () => new PdfkitCommissionPdfRenderer(),
    },
    TokenService,
    TenantContextInterceptor,
    { provide: COMMISSION_CLOCK, useValue: () => new Date() },
    { provide: COMMISSION_REPOSITORY, useClass: PrismaCommissionRepository },
  ],
})
export class CommissionsModule {}
