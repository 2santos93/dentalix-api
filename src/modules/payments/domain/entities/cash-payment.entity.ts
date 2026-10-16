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
  notes: string | null;
  location: { id: string; name: string };
  patient: { id: string; fullName: string };
  treatmentPlan: {
    id: string;
    status: TreatmentPlanStatus;
    createdAt: Date;
  };
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

/** Total del período por método y moneda. `method: null` = abono sin método. */
export interface CashMethodTotal {
  method: PaymentMethod | null;
  currency: string;
  total: number;
  count: number;
}
