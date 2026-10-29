import type { ReceiptViewSnapshot } from '../receipt-snapshot';

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
  /** La foto con el paciente ya leído (DX-327: nombre visible resuelto). */
  snapshot: ReceiptViewSnapshot;
}
