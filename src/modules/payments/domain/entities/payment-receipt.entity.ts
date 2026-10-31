import type {
  ReceiptSplitLine,
  ReceiptViewSnapshot,
} from '../receipt-snapshot';
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
 * DX-390: una forma de pago del cobro dividido en su recibo, con su tasa
 * congelada (como `exchangeRate`: la de hoy de la línea, que no cambia) y su
 * equivalente en la moneda del plan (`null` mientras esté «sin tasa»).
 */
export interface ReceiptSplitLineView extends ReceiptSplitLine {
  exchangeRate: ReceiptExchangeRate | null;
}

/** DX-390: las formas de pago del recibo y su total en la moneda del plan. */
export interface ReceiptSplitView {
  lines: ReceiptSplitLineView[];
  /** `amount` `null` si alguna línea sigue «sin tasa». */
  total: { currency: string; amount: number | null };
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
  /**
   * DX-376: `null` si el abono está en la moneda de su destino. DX-390: en un
   * cobro dividido, `null` (cada línea lleva la suya en `split`).
   */
  exchangeRate: ReceiptExchangeRate | null;
  /** DX-390: el cobro dividido del recibo; `null` en un abono suelto. */
  split: ReceiptSplitView | null;
  /** La foto con el paciente ya leído (DX-327: nombre visible resuelto). */
  snapshot: ReceiptViewSnapshot;
}
