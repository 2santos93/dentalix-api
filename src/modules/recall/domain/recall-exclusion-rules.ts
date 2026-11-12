/**
 * DX-015-bis · Exclusión entre tipos de recall (D9). Dos recalls de un
 * paciente cuyos tipos comparten `exclusionGroup` no están activos a la vez:
 * cuando uno pasa a activo (lo crea o lo mueve un DONE, lo reactiva un DONE o
 * lo da de alta o reactiva el PUT), los demás del grupo se desactivan. Puro:
 * lo usan la transacción del DONE y la del PUT, y los tests.
 */

/** Un recall que el cambio deja activo y que creó, movió o reactivó. */
export interface ExclusionCandidate {
  recallId: string;
  recallTypeId: string;
  recallTypeName: string;
  exclusionGroup: string | null;
  /** Base del vencimiento (día civil). */
  lastDoneAt: string;
  intervalMonths: number;
}

/**
 * Orden de preferencia entre dos candidatos del MISMO grupo en un mismo
 * cambio (p. ej. un procedimiento que dispara a la vez higiene y perio): la
 * base más reciente; con la misma, el intervalo más corto (el perio, que
 * sustituye a la higiene); luego el id. Es el mismo orden del relleno único
 * (`dx_recall_exclusion_backfill`).
 */
export function compareExclusionCandidates(
  a: ExclusionCandidate,
  b: ExclusionCandidate,
): number {
  if (a.lastDoneAt !== b.lastDoneAt)
    return a.lastDoneAt > b.lastDoneAt ? -1 : 1;
  if (a.intervalMonths !== b.intervalMonths) {
    return a.intervalMonths - b.intervalMonths;
  }
  return a.recallId < b.recallId ? -1 : a.recallId > b.recallId ? 1 : 0;
}

/** El recall que se queda activo en cada grupo (los tipos sin grupo no cuentan). */
export function pickExclusionWinners(
  candidates: readonly ExclusionCandidate[],
): Map<string, ExclusionCandidate> {
  const winners = new Map<string, ExclusionCandidate>();
  for (const candidate of [...candidates].sort(compareExclusionCandidates)) {
    const group = candidate.exclusionGroup;
    if (group !== null && !winners.has(group)) winners.set(group, candidate);
  }
  return winners;
}
