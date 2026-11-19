import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PatientImportsModule } from '../patient-imports/patient-imports.module';
import {
  ImportReadSlotInterceptor,
  ImportUploadSlotGuard,
} from '../patient-imports/presentation/import-read-slots';
import { BankReconciliationService } from './application/bank-reconciliation.service';
import { PrismaBankReconciliationRepository } from './infrastructure/prisma-bank-reconciliation.repository';
import { BankReconciliationController } from './presentation/bank-reconciliation.controller';

/**
 * Caja › Conciliación (DX-571): cuentas que reciben transferencias y pagos
 * móviles, importación del extracto (CSV/Excel, con el lector y las plazas de
 * lectura de DX-107/SEC-046), emparejado automático por referencia
 * normalizada e importe, las cuatro listas del período y el emparejado a
 * mano. La anulación de un abono desconcilia en su propia transacción
 * (`releaseBankMatchOnVoid`, desde el repositorio de abonos).
 */
@Module({
  imports: [JwtModule.register({}), PatientImportsModule],
  controllers: [BankReconciliationController],
  providers: [
    BankReconciliationService,
    PrismaBankReconciliationRepository,
    TokenService,
    TenantContextInterceptor,
    ImportUploadSlotGuard,
    ImportReadSlotInterceptor,
  ],
})
export class BankReconciliationModule {}
