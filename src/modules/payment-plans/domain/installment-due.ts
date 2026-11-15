/**
 * DX-110: la ÚNICA regla de «vencida» de una cuota (o de la cuota inicial) de
 * un plan de pagos. La usan el plan de pagos, el estado de cuenta, la cartera,
 * la marca «Saldo vencido» de la agenda y la ficha y el «¿quién llama?».
 *
 * - El vencimiento es un DÍA CIVIL: la cuota se guarda a medianoche UTC de su
 *   día (`generateSchedule` suma en UTC sobre el `startDate` `YYYY-MM-DD`), así
 *   que su día es el día UTC de `dueDate`.
 * - «Hoy» es el día civil de la SEDE DEL PLAN (`civilDateIn(now, zona)`), no
 *   el día UTC: comparando en UTC, en Caracas (UTC−4) una cuota pasaba a
 *   vencida a las 20:00 del mismo día de vencimiento.
 * - Vencida = su día es ANTERIOR a hoy en la sede: el día de vencimiento
 *   entero todavía se puede pagar sin que salga vencida.
 */

/** El día civil (YYYY-MM-DD) del vencimiento de una cuota. */
export function dueDayOf(dueDate: Date): string {
  return dueDate.toISOString().slice(0, 10);
}

/** ¿Venció ya? `today` es el día civil de hoy en la zona de la sede del plan. */
export function isDueDayPast(dueDate: Date, today: string): boolean {
  return dueDayOf(dueDate) < today;
}

/**
 * La sede de un plan de pagos es la de su plan de tratamiento: donde se
 * aceptó o, sin aceptación registrada, donde se presentó. `null` = ninguna de
 * las dos: rige la sede principal de la clínica (como en la cartera, R6).
 */
export function paymentPlanLocationId(plan: {
  acceptedLocationId: string | null;
  presentedLocationId: string | null;
}): string | null {
  return plan.acceptedLocationId ?? plan.presentedLocationId ?? null;
}
