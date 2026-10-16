import { ClinicRole, TreatmentPlanStatus } from '@prisma/client';

const { PRESENTED, ACCEPTED, REJECTED, COMPLETED, CANCELLED } =
  TreatmentPlanStatus;

/**
 * Máquina de estados del plan de tratamiento (DX-040, BE-002). Antes el
 * `status` era libre (CANCELLED → ACCEPTED, COMPLETED → DRAFT…); ahora toda
 * escritura de estado pasa por esta tabla y lo que no está aquí es un 409.
 *
 *  - DRAFT → PRESENTED → ACCEPTED | REJECTED: el presupuesto se presenta al
 *    paciente y este lo acepta o lo rechaza.
 *  - DRAFT → ACCEPTED: se acepta sin presentarlo antes (la aceptación firmada
 *    de DX-012 nació así y sigue valiendo).
 *  - ACCEPTED → COMPLETED: el tratamiento terminó.
 *  - cualquiera salvo COMPLETED → CANCELLED. COMPLETED y CANCELLED son finales.
 *
 * Quedarse en el mismo estado no es una transición.
 *
 * Esta es la tabla de lo que pide el PERSONAL. Hay además una transición del
 * SISTEMA que no está aquí a propósito: al aceptar una opción, sus hermanas en
 * DRAFT (o PRESENTED) pasan a REJECTED con el motivo OTHER_OPTION_ACCEPTED
 * (`rejectOpenSiblings`, `domain/plan-options.ts`). Por eso un borrador puede
 * aparecer rechazado aunque DRAFT → REJECTED no se pueda pedir.
 */
export const PLAN_STATUS_TRANSITIONS: Readonly<
  Record<TreatmentPlanStatus, readonly TreatmentPlanStatus[]>
> = {
  DRAFT: [PRESENTED, ACCEPTED, CANCELLED],
  PRESENTED: [ACCEPTED, REJECTED, CANCELLED],
  ACCEPTED: [COMPLETED, CANCELLED],
  REJECTED: [CANCELLED],
  COMPLETED: [],
  CANCELLED: [],
};

/** Nombre del estado tal como lo lee el personal (mensajes de error). */
export const PLAN_STATUS_LABELS: Readonly<Record<TreatmentPlanStatus, string>> =
  {
    DRAFT: 'Borrador',
    PRESENTED: 'Presentado',
    ACCEPTED: 'Aceptado',
    REJECTED: 'Rechazado',
    COMPLETED: 'Completado',
    CANCELLED: 'Cancelado',
  };

export function canTransition(
  from: TreatmentPlanStatus,
  to: TreatmentPlanStatus,
): boolean {
  return PLAN_STATUS_TRANSITIONS[from].includes(to);
}

/** `null` si `from → to` está permitida; si no, el motivo en español (409). */
export function planTransitionError(
  from: TreatmentPlanStatus,
  to: TreatmentPlanStatus,
): string | null {
  if (canTransition(from, to)) return null;
  return `Un plan «${PLAN_STATUS_LABELS[from]}» no puede pasar a «${PLAN_STATUS_LABELS[to]}».`;
}

/**
 * Quién decide el plan (DX-040): presentarlo y aceptarlo —también con firma—
 * es del odontólogo y de la administración. La asistente lo ve y lo prepara,
 * pero no lo acepta en nombre del doctor. Las rutas aplican el mismo conjunto
 * (`TREATMENT_PLAN_DECISION_ROLES`); el PATCH de estado, que es de todos los
 * roles clínicos, lo comprueba aquí.
 */
export const PLAN_DECISION_ROLES: readonly ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ADMIN,
];

/**
 * Planes que NO se cobran: el cancelado y el rechazado por el paciente
 * (DX-040). Su facturable no suma al saldo ni se ofrece para cobrar; los
 * abonos que tuviera siguen contando como recibidos. Única fuente para el
 * estado de cuenta y los planes cobrables.
 */
export const NON_BILLABLE_PLAN_STATUSES: readonly TreatmentPlanStatus[] = [
  CANCELLED,
  REJECTED,
];

export function isPlanBillable(status: TreatmentPlanStatus): boolean {
  return !NON_BILLABLE_PLAN_STATUSES.includes(status);
}
