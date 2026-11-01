import type { ConfigSnapshot } from '../../audit/domain/config-audit';
import type { PaymentMethodAdjustmentEntity } from './payment-method.entity';

/**
 * DX-360/DX-516: lo que la auditoría de configuración guarda de un ajuste por
 * medio de pago (todo es configuración corta: etiqueta, tipo, cálculo,
 * importe y estado). El evento es del medio (`PAYMENT_METHOD`); la etiqueta,
 * única en el medio, distingue sus ajustes.
 */
export function paymentAdjustmentSnapshot(
  adjustment: PaymentMethodAdjustmentEntity,
): ConfigSnapshot {
  return {
    adjustmentLabel: adjustment.label,
    adjustmentType: adjustment.type,
    calculation: adjustment.calculation,
    percent: adjustment.percent,
    fixedAmount: adjustment.fixedAmount,
    fixedCurrency: adjustment.fixedCurrency,
    active: adjustment.active,
  };
}
