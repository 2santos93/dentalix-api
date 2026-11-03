import { TreatmentPlanStatus } from '@prisma/client';
import type {
  PaymentWithoutRate,
  PlanBalanceInput,
} from '../../../payments/application/use-cases/get-plan-balance.use-case';

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
  /**
   * DX-472-bis: lo que necesita el saldo del plan (`PlanBalanceCalculator`).
   * Sin él, lo abonado en otra moneda no cuenta (como antes).
   */
  balanceInput?: PlanBalanceInput;
}

export interface BillablePlan {
  id: string;
  status: TreatmentPlanStatus;
  currency: string;
  createdAt: Date;
  /** Facturable del plan, en su moneda. */
  total: number;
  /**
   * Abonado en la moneda del plan, más los asientos del saldo a favor
   * (DX-253). DX-472-bis: lo abonado en otra moneda cuenta convertido, como
   * en `/balance` y en el estado de cuenta.
   */
  paid: number;
  /** Abonos vivos en otra moneda tal como se entregaron, sin convertir. */
  paidOtherCurrencies: { currency: string; amount: number }[];
  /** `total - paid`; negativo = a favor del paciente. El de `/balance`. */
  balance: number;
  hasActivePaymentPlan: boolean;
  /** DX-472-bis: abonos que no suman por falta de tasa (los de `/balance`). */
  paymentsWithoutRate: PaymentWithoutRate[];
  /** DX-472-bis: el proveedor no respondió a tiempo; volver a pedirlo. */
  rateProviderTimedOut: boolean;
}
