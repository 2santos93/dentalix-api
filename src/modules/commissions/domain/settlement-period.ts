import {
  PERIOD_DAY_OUT_OF_RANGE_MESSAGE,
  addCivilDays,
  checkPeriodDays,
} from '../../../shared/time/civil-day';
import type { SettlementPeriod } from './commission-calculator';

/** Una liquidación cubre como mucho un año (quincena y mes son lo normal). */
export const SETTLEMENT_PERIOD_MAX_DAYS = 366;

export const SETTLEMENT_PERIOD_MESSAGES = {
  invalid:
    'El período no es válido: «desde» y «hasta» son fechas AAAA-MM-DD y «desde» no puede ser posterior a «hasta».',
  outOfRange: PERIOD_DAY_OUT_OF_RANGE_MESSAGE,
  tooLong: `Una liquidación cubre como mucho ${SETTLEMENT_PERIOD_MAX_DAYS} días.`,
} as const;

export type ParsedPeriod =
  { ok: true; period: SettlementPeriod } | { ok: false; message: string };

export function parseSettlementPeriod(from: string, to: string): ParsedPeriod {
  const check = checkPeriodDays(from, to);
  if (!check.ok) {
    return {
      ok: false,
      message:
        check.problem === 'OUT_OF_RANGE'
          ? SETTLEMENT_PERIOD_MESSAGES.outOfRange
          : SETTLEMENT_PERIOD_MESSAGES.invalid,
    };
  }
  if (check.days > SETTLEMENT_PERIOD_MAX_DAYS) {
    return { ok: false, message: SETTLEMENT_PERIOD_MESSAGES.tooLong };
  }
  return { ok: true, period: { from: check.from, to: check.to } };
}

/** Por qué no se puede cerrar (todavía) una liquidación de ese período. */
export type CloseBlocker =
  | 'NO_RULE'
  | 'RULE_INACTIVE'
  | 'PERIOD_NOT_ENDED'
  | 'OVERLAPS_PREVIOUS'
  | 'GAP_AFTER_PREVIOUS';

export const CLOSE_BLOCKER_MESSAGES: Record<CloseBlocker, string> = {
  NO_RULE:
    'Este profesional no tiene regla de honorarios: configúrala antes de liquidar.',
  RULE_INACTIVE: 'La regla de honorarios de este profesional está desactivada.',
  PERIOD_NOT_ENDED:
    'El período todavía no ha terminado: solo se cierra cuando «hasta» es anterior a hoy en la sede.',
  OVERLAPS_PREVIOUS:
    'El período se solapa con una liquidación ya cerrada de este profesional.',
  GAP_AFTER_PREVIOUS:
    'El período tiene que empezar el día siguiente a la última liquidación cerrada, para que nada quede fuera.',
};

export interface CloseContext {
  period: SettlementPeriod;
  /** Hoy en la sede de la petición. */
  today: string;
  /** El «hasta» de la última liquidación cerrada del profesional, si hay. */
  lastClosedTo: string | null;
  /** Hay alguna cerrada que se solape con el período. */
  overlaps: boolean;
  rule: { active: boolean } | null;
}

/**
 * La primera razón que impide cerrar, o `null` si se puede. Las liquidaciones
 * de un profesional van seguidas (la siguiente empieza el día después de la
 * anterior) para que ningún devengo caiga en un hueco; la primera, libre.
 * Un período sin nada que liquidar también se cierra (queda en 0 y deja paso
 * al siguiente).
 */
export function closeBlocker(ctx: CloseContext): CloseBlocker | null {
  if (ctx.rule === null) return 'NO_RULE';
  if (!ctx.rule.active) return 'RULE_INACTIVE';
  if (ctx.period.to >= ctx.today) return 'PERIOD_NOT_ENDED';
  if (ctx.overlaps) return 'OVERLAPS_PREVIOUS';
  if (ctx.lastClosedTo !== null) {
    if (ctx.period.from <= ctx.lastClosedTo) return 'OVERLAPS_PREVIOUS';
    if (ctx.period.from !== addCivilDays(ctx.lastClosedTo, 1)) {
      return 'GAP_AFTER_PREVIOUS';
    }
  }
  return null;
}

/** El cierre contable tras liquidar: el más tardío entre el vigente y el «hasta»; nunca retrocede. */
export function lockDateAfterSettlement(
  current: string | null,
  periodTo: string,
): string {
  return current !== null && current > periodTo ? current : periodTo;
}
