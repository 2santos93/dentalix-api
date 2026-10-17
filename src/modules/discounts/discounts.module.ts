import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import {
  GetDiscountPolicyUseCase,
  UpdateDiscountPolicyUseCase,
} from './application/use-cases/discount-policy.use-cases';
import { GetDiscountReportUseCase } from './application/use-cases/get-discount-report.use-case';
import { DISCOUNT_POLICY_REPOSITORY } from './domain/ports/discount-policy-repository.port';
import { DISCOUNT_REPORT_REPOSITORY } from './domain/ports/discount-report-repository.port';
import { PrismaDiscountPolicyRepository } from './infrastructure/prisma-discount-policy.repository';
import { PrismaDiscountReportRepository } from './infrastructure/prisma-discount-report.repository';
import { DiscountPolicyController } from './presentation/discount-policy.controller';
import { DiscountReportController } from './presentation/discount-report.controller';

// Descuentos (DX-204): política de la clínica (topes por rol y umbral del
// motivo) e informe. Exporta `GetDiscountPolicyUseCase`: los casos de uso de
// los ítems de plan la aplican en el servidor.
@Module({
  imports: [JwtModule.register({})],
  controllers: [DiscountPolicyController, DiscountReportController],
  providers: [
    GetDiscountPolicyUseCase,
    UpdateDiscountPolicyUseCase,
    GetDiscountReportUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: DISCOUNT_POLICY_REPOSITORY,
      useClass: PrismaDiscountPolicyRepository,
    },
    {
      provide: DISCOUNT_REPORT_REPOSITORY,
      useClass: PrismaDiscountReportRepository,
    },
  ],
  exports: [GetDiscountPolicyUseCase],
})
export class DiscountsModule {}
