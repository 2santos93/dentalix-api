import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  ClinicRole,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import { ATTENDING_ROLES } from '../../schedule-blocks/domain/schedule-block-rules';
import { CLOSED_PLAN_STATUSES } from './plan-status-machine';

/**
 * DX-050 · Producción atribuible. Un ítem REALIZADO guarda quién lo hizo
 * (`performedById`, un miembro de la clínica que atiende: DENTIST o ADMIN),
 * dónde (`performedLocationId`, la sede del request) y cuándo (`completedAt`,
 * hora del servidor). Es la base de la producción por profesional (DX-014) y
 * de la liquidación sobre lo producido (DX-018).
 *
 * Reglas:
 *  - Pasar a DONE: sin `performedById` se usa quien marca si atiende; si no
 *    (la asistente), 400. `completedAt` nunca llega del cliente.
 *  - Ya DONE: cambiar quién o cuándo es solo de ADMIN (403) y queda auditado.
 *  - Salir de DONE (a aceptado o propuesto): la atribución se limpia y queda
 *    auditada con el antes. Lo hace un ADMIN o quien lo realizó (un «marcado
 *    por error»); otro no, para que nadie se lleve la producción ajena.
 *  - Los DONE anteriores a DX-050 no tienen atribución («Sin atribuir»). Un
 *    ADMIN los atribuye indicando quién, cuándo Y en qué sede (DX-305): sin
 *    sede o sin fecha no cuentan en la producción de «Comparar sedes». La
 *    sede tiene que ser de las permitidas al usuario (DX-089).
 */
export const PERFORMER_REQUIRED_MESSAGE =
  'Indica qué profesional realizó el procedimiento.';
export const PERFORMER_NOT_FOUND_MESSAGE =
  'Profesional no encontrado en esta clínica.';
export const PERFORMER_NOT_ATTENDING_MESSAGE =
  'Ese miembro del equipo no atiende pacientes: no puede figurar como quien realizó el procedimiento.';
export const PERFORMER_NOT_AT_LOCATION_MESSAGE =
  'Ese profesional no atiende en esta sede.';
export const COMPLETED_AT_BY_SERVER_MESSAGE =
  'La fecha de realización la pone el sistema al marcarlo como realizado.';
export const COMPLETED_AT_FUTURE_MESSAGE =
  'La fecha de realización no puede ser futura.';
export const ATTRIBUTION_ONLY_WHEN_DONE_MESSAGE =
  'Quién lo realizó y cuándo solo se indican en un procedimiento realizado.';
export const ATTRIBUTION_ADMIN_ONLY_MESSAGE =
  'Solo un administrador puede cambiar quién realizó un procedimiento o cuándo.';
export const UNATTRIBUTED_CORRECTION_INCOMPLETE_MESSAGE =
  'Para atribuir un procedimiento «Sin atribuir» indica quién lo realizó, cuándo y en qué sede.';
export const LOCATION_BY_REQUEST_MESSAGE =
  'La sede donde se realizó es la sede activa al marcarlo como realizado.';
export const PERFORMED_LOCATION_NOT_FOUND_MESSAGE =
  'La sede no es de esta clínica.';
export const REVERT_DONE_FORBIDDEN_MESSAGE =
  'Solo un administrador o quien lo realizó puede quitarle «Realizado» a un procedimiento.';

/** Lo que importa del ítem (leído con su fila bloqueada). */
export interface AttributionState {
  status: TreatmentPlanItemStatus;
  performedById: string | null;
  performedLocationId: string | null;
  completedAt: Date | null;
}

/** Lo que pide la petición. */
export interface AttributionRequest {
  status?: TreatmentPlanItemStatus;
  performedById?: string;
  completedAt?: Date;
  /** Solo al corregir un ítem ya DONE (ADMIN). */
  performedLocationId?: string;
}

export interface AttributionActor {
  userId: string;
  role: ClinicRole;
}

/**
 * Cambio de atribución que aplica el repositorio en la transacción del ítem:
 *  - SET: pasa a DONE; la sede la pone el repositorio (`X-Location-Id` o la
 *    de escritura de la sesión) y comprueba que el profesional sea un miembro
 *    vivo de la clínica, que atienda y que atienda en esa sede;
 *  - CORRECT: un ADMIN cambia quién, cuándo o dónde (lo que no venga, se
 *    queda); el repositorio comprueba que la sede sea de la clínica y de las
 *    permitidas al usuario (DX-089);
 *  - CLEAR: sale de DONE y se limpian los cuatro campos.
 * CORRECT y CLEAR dejan un evento de auditoría con el antes y el después.
 */
export type ItemAttributionChange =
  | { kind: 'SET'; performedById: string; completedAt: Date }
  | {
      kind: 'CORRECT';
      performedById?: string;
      completedAt?: Date;
      performedLocationId?: string;
    }
  | { kind: 'CLEAR' };

export function isAttendingRole(role: ClinicRole): boolean {
  return ATTENDING_ROLES.includes(role);
}

function hasAttributionFields(request: AttributionRequest): boolean {
  return (
    request.performedById !== undefined ||
    request.completedAt !== undefined ||
    request.performedLocationId !== undefined
  );
}

/**
 * Decide el cambio de atribución de una petición sobre el ítem. `undefined` =
 * la atribución no cambia. Lanza 400/403 con el motivo en español.
 */
export function decideAttribution(
  item: AttributionState,
  request: AttributionRequest,
  actor: AttributionActor,
  now: Date,
): ItemAttributionChange | undefined {
  const wasDone = item.status === TreatmentPlanItemStatus.DONE;
  const target = request.status ?? item.status;
  const willBeDone = target === TreatmentPlanItemStatus.DONE;

  if (!willBeDone) {
    if (hasAttributionFields(request)) {
      throw new BadRequestException(ATTRIBUTION_ONLY_WHEN_DONE_MESSAGE);
    }
    if (!wasDone) return undefined;
    if (
      actor.role !== ClinicRole.ADMIN &&
      item.performedById !== actor.userId
    ) {
      throw new ForbiddenException(REVERT_DONE_FORBIDDEN_MESSAGE);
    }
    return { kind: 'CLEAR' };
  }

  if (!wasDone) {
    if (request.completedAt !== undefined) {
      throw new BadRequestException(COMPLETED_AT_BY_SERVER_MESSAGE);
    }
    if (request.performedLocationId !== undefined) {
      throw new BadRequestException(LOCATION_BY_REQUEST_MESSAGE);
    }
    const performedById =
      request.performedById ??
      (isAttendingRole(actor.role) ? actor.userId : undefined);
    if (performedById === undefined) {
      throw new BadRequestException(PERFORMER_REQUIRED_MESSAGE);
    }
    return { kind: 'SET', performedById, completedAt: now };
  }

  const performerChanges =
    request.performedById !== undefined &&
    request.performedById !== item.performedById;
  const requestedAt = request.completedAt;
  const dateChanges =
    requestedAt !== undefined &&
    requestedAt.getTime() !== item.completedAt?.getTime();
  const locationChanges =
    request.performedLocationId !== undefined &&
    request.performedLocationId !== item.performedLocationId;
  if (!performerChanges && !dateChanges && !locationChanges) return undefined;
  if (actor.role !== ClinicRole.ADMIN) {
    throw new ForbiddenException(ATTRIBUTION_ADMIN_ONLY_MESSAGE);
  }
  if (dateChanges && requestedAt.getTime() > now.getTime()) {
    throw new BadRequestException(COMPLETED_AT_FUTURE_MESSAGE);
  }
  // DX-305 (BE-045): un «Sin atribuir» se atribuye entero o no cuenta en la
  // producción por sede; lo que ya tiene se puede no repetir.
  if (
    (item.performedById ?? request.performedById) === undefined ||
    (item.completedAt ?? requestedAt) === undefined ||
    (item.performedLocationId ?? request.performedLocationId) === undefined
  ) {
    throw new BadRequestException(UNATTRIBUTED_CORRECTION_INCOMPLETE_MESSAGE);
  }
  return {
    kind: 'CORRECT',
    ...(performerChanges ? { performedById: request.performedById } : {}),
    ...(dateChanges ? { completedAt: requestedAt } : {}),
    ...(locationChanges
      ? { performedLocationId: request.performedLocationId }
      : {}),
  };
}

/**
 * En un plan CERRADO (DX-109) los ítems no cambian, salvo la corrección de la
 * atribución de uno ya REALIZADO (quién, cuándo o dónde, nada más): la producción se
 * corrige aunque el plan haya terminado. El trigger
 * `treatment_plan_items_locked_when_closed` aplica la misma excepción.
 */
export function isAttributionCorrection(
  planStatus: TreatmentPlanStatus,
  itemStatus: TreatmentPlanItemStatus,
  patch: AttributionRequest & {
    price?: unknown;
    discount?: unknown;
    discountReason?: unknown;
    discountReasonNote?: unknown;
    surfaces?: unknown;
    notes?: unknown;
  },
): boolean {
  return (
    CLOSED_PLAN_STATUSES.includes(planStatus) &&
    itemStatus === TreatmentPlanItemStatus.DONE &&
    (patch.status === undefined ||
      patch.status === TreatmentPlanItemStatus.DONE) &&
    hasAttributionFields(patch) &&
    patch.price === undefined &&
    patch.discount === undefined &&
    patch.discountReason === undefined &&
    patch.discountReasonNote === undefined &&
    patch.surfaces === undefined &&
    patch.notes === undefined
  );
}
