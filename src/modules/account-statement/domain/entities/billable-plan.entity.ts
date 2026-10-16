import { TreatmentPlanStatus } from '@prisma/client';

/*
 * Planes COBRABLES de un paciente (DX-067): lo mínimo para que quien cobra
 * elija contra qué plan registra un abono o un plan de cuotas, sin entrar al
 * plan de tratamiento, que es clínico.
 *
 * Deliberadamente SIN datos clínicos: ni ítems, ni dientes, ni procedimientos,
 * ni notas. El plan no tiene título; la web lo nombra por su fecha de creación,
 * igual que el estado de cuenta y la caja.
 */

/** Lo que lee el repositorio, ya en `number`. */
export interface BillablePlanRow {
  id: string;
  status: TreatmentPlanStatus;
  currency: string;
  createdAt: Date;
  /** Σ precio de los ítems vivos ACCEPTED|DONE (lo facturable del plan). */
  billable: number;
  /** Abonos VIVOS del plan, sumados por moneda (sin convertir). */
  paidByCurrency: { currency: string; amount: number }[];
  /** Si ya tiene un plan de pagos ACTIVE (solo admite uno). */
  hasActivePaymentPlan: boolean;
}

export interface BillablePlan {
  id: string;
  status: TreatmentPlanStatus;
  currency: string;
  createdAt: Date;
  /** Facturable del plan, en su moneda. */
  total: number;
  /** Abonos vivos hechos en la moneda del plan. */
  paid: number;
  /** Abonos vivos en otra moneda: se informan aparte, sin convertir. */
  paidOtherCurrencies: { currency: string; amount: number }[];
  /** `total - paid`; negativo = a favor del paciente. */
  balance: number;
  hasActivePaymentPlan: boolean;
}
