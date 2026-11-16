import {
  BadRequestException,
  ConflictException,
  HttpStatus,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { addCivilDays, civilDateIn } from '../../../shared/time/civil-day';

/**
 * DX-091: cierre contable de la clínica. Dos ajustes en `tenants`, los dos
 * opcionales; rige el MÁS restrictivo (el cierre más tardío):
 *  - `lockDate`: día civil fijo (YYYY-MM-DD), cerrado él y todo lo anterior;
 *  - `lockDays`: días abiertos hacia atrás. Con N quedan abiertos hoy y los N
 *    días anteriores; cerrado todo lo de antes (N = 0: solo hoy).
 * «Hoy» y el día de cada abono son días civiles de la SEDE del abono (su
 * `Location.timeZone`), nunca del servidor ni UTC. La fecha fija es la misma
 * para todas las sedes.
 */
export interface FinancialLockSettings {
  lockDate: string | null;
  lockDays: number | null;
  /** El ADMIN puede saltar el cierre indicando un motivo (queda registrado). */
  adminExempt: boolean;
}

export const FINANCIAL_LOCK_DAYS_MAX = 365;

/**
 * El último día cerrado (inclusive) con `today` como hoy en la sede, o `null`
 * si la clínica no tiene cierre.
 */
export function lockedThrough(
  settings: Pick<FinancialLockSettings, 'lockDate' | 'lockDays'>,
  today: string,
): string | null {
  const byDays =
    settings.lockDays === null
      ? null
      : addCivilDays(today, -(settings.lockDays + 1));
  const candidates = [settings.lockDate, byDays].filter(
    (day): day is string => day !== null,
  );
  if (candidates.length === 0) return null;
  // YYYY-MM-DD se ordena como texto.
  return candidates.reduce((a, b) => (a > b ? a : b));
}

/** `lockedThrough` con el «hoy» de `now` en la zona de la sede. */
export function lockedThroughAt(
  settings: Pick<FinancialLockSettings, 'lockDate' | 'lockDays'>,
  now: Date,
  timeZone: string,
): string | null {
  return lockedThrough(settings, civilDateIn(now, timeZone));
}

/** ¿Está cerrado el día civil `day` con el cierre `through`? */
export function isCivilDayLocked(day: string, through: string | null): boolean {
  return through !== null && day <= through;
}

/** Qué se intenta hacer sobre un período cerrado (el registro de excepciones). */
export type FinancialLockOperation =
  | 'PAYMENT_CREATE'
  | 'PAYMENT_VOID'
  | 'PAYMENT_PLAN_CREATE'
  | 'PAYMENT_PLAN_CANCEL';

export const PERIOD_LOCKED_CODE = 'PERIOD_LOCKED';

export const PERIOD_LOCKED_MESSAGES: Record<FinancialLockOperation, string> = {
  PAYMENT_CREATE:
    'La fecha del abono cae en un período contable cerrado. Elige una fecha posterior al cierre o pide a administración que lo revise.',
  PAYMENT_VOID:
    'El abono es de un período contable cerrado: ya no se puede anular. Pide a administración que lo revise.',
  PAYMENT_PLAN_CREATE:
    'El plan de cuotas tiene cuotas que vencen en un período contable cerrado. Empieza las cuotas después del cierre.',
  PAYMENT_PLAN_CANCEL:
    'El plan de cuotas tiene cuotas vencidas en un período contable cerrado: ya no se puede cancelar. Pide a administración que lo revise.',
};

export const LOCK_OVERRIDE_REASON_MIN = 3;
export const LOCK_OVERRIDE_REASON_MAX = 300;
export const LOCK_OVERRIDE_REASON_REQUIRED_MESSAGE =
  'Indica el motivo para hacerlo en un período contable cerrado (de 3 a 300 caracteres).';

/** 409 `PERIOD_LOCKED`, con el último día cerrado para que la web lo diga. */
export function periodLockedException(
  operation: FinancialLockOperation,
  through: string,
): ConflictException {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: PERIOD_LOCKED_CODE,
    message: PERIOD_LOCKED_MESSAGES[operation],
    lockedThrough: through,
  });
}

/** Quién pide la operación y con qué motivo de excepción (si lo trae). */
export interface LockActor {
  userId: string;
  role: ClinicRole;
  /** Motivo para saltar el cierre (`lockOverrideReason` del cuerpo). */
  overrideReason?: string | null;
}

export type LockDecision =
  | { kind: 'open' }
  | { kind: 'locked'; through: string }
  | { kind: 'override'; through: string; reason: string };

/** ¿Puede este actor saltar el cierre de esta clínica (con motivo)? */
export function mayOverrideLock(
  settings: Pick<FinancialLockSettings, 'adminExempt'>,
  role: ClinicRole | null | undefined,
): boolean {
  return settings.adminExempt && role === ClinicRole.ADMIN;
}

/**
 * La regla entera para un día afectado (el más antiguo de la operación):
 * abierto; cerrado (409); o excepción del ADMIN con la clínica que la admite,
 * que exige motivo (400 sin él). RECEPTION nunca la salta: su motivo se
 * ignora y recibe el 409.
 */
export function decideLock(
  day: string,
  settings: FinancialLockSettings,
  through: string | null,
  actor: LockActor | null,
): LockDecision {
  if (!isCivilDayLocked(day, through) || through === null) {
    return { kind: 'open' };
  }
  if (!actor || !mayOverrideLock(settings, actor.role)) {
    return { kind: 'locked', through };
  }
  const reason = actor.overrideReason?.trim() ?? '';
  if (
    reason.length < LOCK_OVERRIDE_REASON_MIN ||
    reason.length > LOCK_OVERRIDE_REASON_MAX
  ) {
    throw new BadRequestException(LOCK_OVERRIDE_REASON_REQUIRED_MESSAGE);
  }
  return { kind: 'override', through, reason };
}

/** La decisión como error: 409 si queda cerrado. */
export function assertLockDecision(
  decision: LockDecision,
  operation: FinancialLockOperation,
): void {
  if (decision.kind === 'locked') {
    throw periodLockedException(operation, decision.through);
  }
}

/** Lo que una lista (Caja, Estado de cuenta) dice de anular un abono. */
export interface VoidLockState {
  /** El día del abono en su sede está cerrado. */
  periodLocked: boolean;
  /** Cerrado y quien consulta no puede saltarlo: `canVoid` es `false`. */
  blocksVoid: boolean;
}

/**
 * DX-091: el `periodLocked` y el `canVoid` de cada abono de Caja y Estado de
 * cuenta (DX-057), con la misma regla que aplica la anulación. Sin ajustes
 * (`settings` ausente) nada está cerrado.
 */
export function voidLockState(
  settings: FinancialLockSettings | null | undefined,
  paidAt: Date,
  timeZone: string,
  now: Date,
  role: ClinicRole | null | undefined,
): VoidLockState {
  if (!settings || (settings.lockDate === null && settings.lockDays === null)) {
    return { periodLocked: false, blocksVoid: false };
  }
  const through = lockedThroughAt(settings, now, timeZone);
  const periodLocked = isCivilDayLocked(civilDateIn(paidAt, timeZone), through);
  return {
    periodLocked,
    blocksVoid: periodLocked && !mayOverrideLock(settings, role),
  };
}
