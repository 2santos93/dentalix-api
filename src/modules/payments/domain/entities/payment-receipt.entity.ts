import type { ReceiptViewSnapshot } from '../receipt-snapshot';
import type {
  FrozenExchangeRate,
  PaymentExchangeRateStatus,
} from '../payment-exchange-rate';

/**
 * DX-376: la tasa con la que el recibo enseña el equivalente del abono en la
 * moneda de su destino. `rate` y `equivalentAmount` solo con `FROZEN`: la
 * tasa congelada del abono (DX-375), que no cambia aunque cambie la del día.
 */
export interface ReceiptExchangeRate {
  status: Exclude<PaymentExchangeRateStatus, 'NOT_NEEDED'>;
  rate: FrozenExchangeRate | null;
  /** El abono en `rate.currency`, con la tasa congelada. */
  equivalentAmount: number | null;
}

/**
 * El recibo de caja de un abono tal como se muestra, se imprime y se envía
 * (DX-136). `legacy` = abono anterior a la numeración consecutiva: conserva
 * su referencia antigua (`REC-xxxxxxxx`), «sin serie», y su foto se arma con
 * los datos de hoy.
 */
export interface PaymentReceiptView {
  paymentId: string;
  /** `NOR-000123`, o `REC-xxxxxxxx` si es «sin serie». */
  reference: string;
  seriesPrefix: string | null;
  number: number | null;
  legacy: boolean;
  issuedAt: Date;
  voided: boolean;
  voidedAt: Date | null;
  voidReason: string | null;
  /** DX-376: `null` si el abono está en la moneda de su destino. */
  exchangeRate: ReceiptExchangeRate | null;
  /** La foto con el paciente ya leído (DX-327: nombre visible resuelto). */
  snapshot: ReceiptViewSnapshot;
}
