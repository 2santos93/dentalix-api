import { PaymentMethod, TreatmentPlanStatus } from '@prisma/client';

/**
 * Una fila de la CAJA (`GET /payments`): el abono con lo que hace falta para
 * leerlo fuera de su plan —quién pagó, en qué sede y contra qué plan—, ya
 * resuelto por el repositorio en la misma consulta. No es `Payment` con más
 * campos: la caja no expone `tenantId`/`createdById`/`updatedAt`, que no le
 * dicen nada a quien cuadra el día.
 *
 * El plan de tratamiento no tiene título en el modelo; se devuelve su estado y
 * su fecha de creación, que es con lo que la ficha del paciente ya lo nombra.
 */
export interface CashPayment {
  id: string;
  /** Día civil del abono (medianoche UTC del día elegido al registrarlo). */
  paidAt: Date;
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
