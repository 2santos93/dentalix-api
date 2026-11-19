import { HttpException } from '@nestjs/common';

/**
 * DX-562: la regla del hueco que falló al revisar una fecha de una serie
 * (crearla o moverla). La serie no se para en la primera: las junta todas
 * para la vista previa y el 409.
 */
export type SlotRuleStep =
  | 'PAST'
  | 'BUSINESS_HOURS'
  | 'LOCATION_HOLIDAY'
  | 'PROVIDER_OFF_SCHEDULE'
  | 'SCHEDULE_BLOCK'
  | 'PROVIDER_OVERLAP'
  | 'PATIENT_OVERLAP'
  | 'CHAIR_OVERLAP';

export interface SlotRuleFailure {
  step: SlotRuleStep;
  /** La misma excepción que daría agendar o mover esa cita suelta. */
  error: HttpException;
}

/** Si se da, las reglas del hueco no lanzan: cada fallo HTTP va aquí. */
export type SlotRuleCollector = (failure: SlotRuleFailure) => void;

/**
 * Corre una regla. Sin `collect`, tal cual (lanza su excepción); con él, un
 * fallo HTTP se anota con su regla y se sigue con `fallback`. Cualquier otro
 * error (la BD, un fallo de programación) se propaga siempre.
 */
export async function attemptRule<T>(
  collect: SlotRuleCollector | undefined,
  step: SlotRuleStep,
  rule: () => Promise<T>,
  fallback: T,
): Promise<T> {
  if (!collect) return rule();
  try {
    return await rule();
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    collect({ step, error });
    return fallback;
  }
}
