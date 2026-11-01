import { PaymentMethod } from '@prisma/client';
import type {
  FrozenExchangeRate,
  PaymentExchangeRateStatus,
} from '../payment-exchange-rate';

/**
 * API-facing shape of a Payment (Abono) — deliberately NOT the raw Prisma
 * model, same convention as Sale/TreatmentPlan. A Payment is registered
 * against a single `TreatmentPlan` (see docs/plans/2026-07-24-payments-pivot.md
 * "Modelo"); `patientId` is denormalized from the plan at creation time
 * (never accepted from the caller — see `RecordPaymentUseCase`). `amount` is
 * a plain `number` here (Prisma stores `Decimal(14,2)` — same convention as
 * `PrismaSaleRepository.mapToEntity` for `total`).
 */
export interface Payment {
  id: string;
  tenantId: string;
  /** Plan del abono; `null` si es contra un saldo migrado (DX-262). */
  treatmentPlanId: string | null;
  /** Saldo migrado del abono (DX-262); `null` si es a un plan. */
  openingBalanceId: string | null;
  patientId: string;
  amount: number;
  currency: string;
  paidAt: Date;
  /** Día civil (YYYY-MM-DD) de `paidAt` en la zona de la sede del abono (DX-097). */
  paidOn: string;
  method: PaymentMethod | null;
  /**
   * DX-377: medio de pago del catálogo de la clínica y su nombre; `null` en un
   * abono sin método (o de una réplica anterior sin enlazar).
   */
  paymentMethodId: string | null;
  paymentMethodName: string | null;
  /** DX-377: la referencia del pago tal como la dio el pagador. */
  reference: string | null;
  /** DX-377: motivo con que se confirmó una referencia repetida. */
  duplicateReferenceReason: string | null;
  /**
   * DX-515: nº de la factura fiscal emitida fuera de Dentalix para el abono,
   * texto libre; `null` si no se anotó.
   */
  externalInvoiceNumber: string | null;
  /**
   * DX-377: solo en la respuesta del alta: los abonos con la misma referencia
   * y medio que se confirmaron con motivo (para la auditoría).
   */
  duplicateReferenceOf?: string[];
  notes: string | null;
  /**
   * DX-390: el cobro dividido del abono (el id de su línea 1, que lleva el
   * recibo) y su número de línea (1–5); `null` en un abono de una sola forma
   * de pago.
   */
  splitId: string | null;
  splitLine: number | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Número del recibo de caja (DX-136), p. ej. `NOR-000123`; `null` en los
   * abonos anteriores a la numeración consecutiva («sin serie»).
   */
  receiptNumber: string | null;
  /**
   * DX-375: moneda a la que convierte su tasa (la del plan o la del saldo
   * migrado); `null` en un abono anterior a DX-375 aún sin congelar.
   */
  exchangeRateCurrency: string | null;
  /** DX-375: la tasa que congeló, o `null` (misma moneda, sin tasa o anterior). */
  frozenRate: FrozenExchangeRate | null;
  /** DX-375: `exchangeRateStatus` de las dos de arriba. */
  exchangeRateStatus: PaymentExchangeRateStatus;
}
