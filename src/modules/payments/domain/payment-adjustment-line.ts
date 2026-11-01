import type {
  PaymentAdjustmentCalculation,
  PaymentAdjustmentType,
} from '@prisma/client';

/**
 * DX-516: un ajuste por medio de pago congelado en un abono, tal como lo
 * leen el abono, la caja, el CSV y el recibo. `base` es el importe del abono
 * y `amount` (> 0) va en su moneda; el signo lo da el tipo (los descuentos
 * restan de lo cobrado). Cuenta solo mientras el abono está vivo.
 */
export interface PaymentAdjustmentLine {
  type: PaymentAdjustmentType;
  label: string;
  calculation: PaymentAdjustmentCalculation;
  /** Solo con PERCENT. */
  percent: number | null;
  /** Solo con FIXED. */
  fixedAmount: number | null;
  base: number;
  amount: number;
  currency: string;
}
