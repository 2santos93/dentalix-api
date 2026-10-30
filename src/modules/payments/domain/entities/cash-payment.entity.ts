import { PaymentMethod, TreatmentPlanStatus } from '@prisma/client';

/**
 * Una fila de la CAJA (`GET /payments`): el abono con lo que hace falta para
 * leerlo fuera de su plan —quién pagó, en qué sede y contra qué plan—, ya
 * resuelto por el repositorio en la misma consulta. No es `Payment` con más
 * campos: la caja no expone `tenantId`/`updatedAt`, que no le dicen nada a
 * quien cuadra el día. `createdById` sí viaja (DX-057): es quién lo registró,
 * lo que decide si recepción puede anularlo.
 *
 * El plan de tratamiento no tiene título en el modelo; se devuelve su estado y
 * su fecha de creación, que es con lo que la ficha del paciente ya lo nombra.
 */
export interface CashPayment {
  id: string;
  /** Quién registró el abono; `null` en abonos antiguos sin autor. */
  createdById: string | null;
  /** Instante del pago (un abono registrado solo con fecha cae al mediodía de su sede). */
  paidAt: Date;
  /**
   * Día civil (YYYY-MM-DD) del pago en la zona de su sede (DX-097): el día de
   * caja en que cuenta. Es lo que se muestra; `paidAt` en UTC puede ser otro.
   */
  paidOn: string;
  amount: number;
  currency: string;
  method: PaymentMethod | null;
  /** DX-377: medio del catálogo (o el inicial de su método) y su nombre. */
  paymentMethod: { id: string; name: string } | null;
  /** DX-377: referencia del pago, tal como la dio el pagador. */
  reference: string | null;
  notes: string | null;
  location: { id: string; name: string };
  patient: { id: string; fullName: string };
  /** `null` si el abono es contra un saldo migrado (DX-262). */
  treatmentPlan: {
    id: string;
    status: TreatmentPlanStatus;
    createdAt: Date;
  } | null;
  /** Saldo migrado del abono (DX-262), o `null` si es a un plan. */
  openingBalance: { id: string; concept: string } | null;
  /**
   * DX-390: el cobro dividido del abono (el id de su línea 1) y cuántas
   * formas de pago tiene; `null` en un abono de una sola forma de pago.
   * Anular una línea anula el cobro entero: la caja lo avisa antes.
   */
  splitId: string | null;
  splitLines: number | null;
}

/**
 * Fila de la respuesta de la caja: el abono y si QUIEN CONSULTA puede anularlo
 * (misma regla que `DELETE /payments/:id`, ver `voidDenial`). Es solo una pista
 * para la interfaz: el endpoint de anulación vuelve a aplicar la regla.
 */
export interface CashPaymentView extends CashPayment {
  canVoid: boolean;
  /**
   * Día civil (YYYY-MM-DD) en que se REGISTRÓ el abono, en la zona de su sede
   * (DX-067). Puede no coincidir con `paidAt`: un abono con fecha de pago
   * antigua registrado hoy es anulable hoy, porque la ventana de recepción
   * mira el registro.
   */
  registeredOn: string;
  /** Si `registeredOn` es hoy en la sede del abono. */
  registeredToday: boolean;
}

/** Total del período en UNA moneda, sin convertir. */
export interface CashCurrencyTotal {
  currency: string;
  total: number;
  count: number;
}

/**
 * DX-377: total del período por medio de pago y moneda. Un abono de una
 * réplica anterior (sin medio) cuenta en el medio inicial de su método;
 * `paymentMethodId: null` = abono sin método.
 */
export interface CashPaymentMethodTotal {
  paymentMethodId: string | null;
  name: string | null;
  currency: string;
  total: number;
  count: number;
}

/** Total del período por método y moneda. `method: null` = abono sin método. */
export interface CashMethodTotal {
  method: PaymentMethod | null;
  currency: string;
  total: number;
  count: number;
}
