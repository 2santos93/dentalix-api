/** Reloj del servidor para los cambios de estado del plan (DX-040). */
export type PlanClock = () => Date;
export const TREATMENT_PLAN_CLOCK = Symbol('TREATMENT_PLAN_CLOCK');
