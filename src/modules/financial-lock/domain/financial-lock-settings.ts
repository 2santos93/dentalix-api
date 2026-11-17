import {
  FINANCIAL_LOCK_DAYS_MAX,
  type FinancialLockOperation,
  type FinancialLockSettings,
} from './financial-lock';
import { parseCivilDate } from '../../../shared/time/civil-day';

/** El cambio de PATCH /clinic/settings/financial-lock: ausente = no cambia, `null` = sin ese cierre. */
export interface FinancialLockPatchInput {
  lockDate?: string | null;
  lockDays?: number | null;
  adminExempt?: boolean;
}

export const FINANCIAL_LOCK_MESSAGES = {
  lockDate: 'La fecha de cierre no es una fecha válida (AAAA-MM-DD).',
  lockDateNotPast:
    'La fecha de cierre tiene que ser anterior a hoy en la sede: hoy sigue abierto.',
  lockDays: `Los días abiertos tienen que ser un número entero de 0 a ${FINANCIAL_LOCK_DAYS_MAX}.`,
  adminExempt: 'La exención del administrador tiene que ser sí o no.',
} as const;

export type ParsedFinancialLockPatch =
  { ok: true; next: FinancialLockSettings } | { ok: false; message: string };

/**
 * El ajuste resultante de aplicar `input` a `current`, o el 400 en español.
 * `today` es hoy en la sede de quien lo cambia: cerrar hoy (o el futuro)
 * dejaría sin poder cobrar el día en curso.
 */
export function applyFinancialLockPatch(
  current: FinancialLockSettings,
  input: FinancialLockPatchInput,
  today: string,
): ParsedFinancialLockPatch {
  const next: FinancialLockSettings = { ...current };
  if (input.lockDate !== undefined) {
    if (input.lockDate === null) {
      next.lockDate = null;
    } else {
      const day =
        typeof input.lockDate === 'string'
          ? parseCivilDate(input.lockDate)
          : null;
      if (day === null) {
        return { ok: false, message: FINANCIAL_LOCK_MESSAGES.lockDate };
      }
      if (day >= today) {
        return { ok: false, message: FINANCIAL_LOCK_MESSAGES.lockDateNotPast };
      }
      next.lockDate = day;
    }
  }
  if (input.lockDays !== undefined) {
    if (
      input.lockDays !== null &&
      (!Number.isInteger(input.lockDays) ||
        input.lockDays < 0 ||
        input.lockDays > FINANCIAL_LOCK_DAYS_MAX)
    ) {
      return { ok: false, message: FINANCIAL_LOCK_MESSAGES.lockDays };
    }
    next.lockDays = input.lockDays;
  }
  if (input.adminExempt !== undefined) {
    if (typeof input.adminExempt !== 'boolean') {
      return { ok: false, message: FINANCIAL_LOCK_MESSAGES.adminExempt };
    }
    next.adminExempt = input.adminExempt;
  }
  return { ok: true, next };
}

/** Una excepción registrada, para Ajustes › Caja › Cierre contable. */
export interface FinancialLockOverrideView {
  id: string;
  createdAt: Date;
  operation: FinancialLockOperation;
  businessDate: string;
  lockedThrough: string;
  reason: string;
  actor: { userId: string; name: string | null };
  paymentId: string | null;
  paymentPlanId: string | null;
  location: { id: string; name: string } | null;
}

/** Lo que devuelve GET (y PATCH) /clinic/settings/financial-lock. */
export interface FinancialLockSettingsView extends FinancialLockSettings {
  /** El último día cerrado hoy en la sede de la petición (`null` sin cierre). */
  lockedThrough: string | null;
  /** Las últimas excepciones, de la más reciente a la más antigua. */
  overrides: FinancialLockOverrideView[];
}

/** GET /payments/period-lock: lo que necesita el formulario de abono. */
export interface PeriodLockView {
  lockedThrough: string | null;
  /** ADMIN con la exención de la clínica: puede elegir un día cerrado con motivo. */
  canOverride: boolean;
}

export const FINANCIAL_LOCK_OVERRIDES_LIMIT = 50;
