import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { CommissionUseCases } from './application/commission.use-cases';
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
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [CommissionsController],
  providers: [
    CommissionUseCases,
    TokenService,
    TenantContextInterceptor,
    { provide: COMMISSION_CLOCK, useValue: () => new Date() },
    { provide: COMMISSION_REPOSITORY, useClass: PrismaCommissionRepository },
  ],
})
export class CommissionsModule {}
