export const PLAN_CREDIT_READER = Symbol('PLAN_CREDIT_READER');

/**
 * DX-253: Σ de los asientos del saldo a favor de un plan en su moneda (con
 * signo: traspasos recibidos − dados − devoluciones). El saldo del plan los
 * suma a lo abonado, igual que el estado de cuenta.
 */
export interface PlanCreditReader {
  netCredit(treatmentPlanId: string, currency: string): Promise<number>;
}
