/** Un responsable tal como lo ve la regla del pagador principal. */
export interface PayerCandidate {
  id: string;
  isPayer: boolean;
  /** Nombre visible (el del paciente responsable o el del contacto). */
  name: string;
}

export const MAX_RESPONSIBLE_PARTIES = 5;

export const SECOND_PAYER_MESSAGE = (name: string): string =>
  `${name} ya es el pagador principal de este paciente. Quítale esa marca antes de elegir a otro.`;

export const TOO_MANY_RESPONSIBLES_MESSAGE = `Un paciente puede tener como mucho ${MAX_RESPONSIBLE_PARTIES} responsables.`;

/**
 * Máximo UN pagador principal vivo por paciente (DX-203; varios pagadores con
 * porcentajes quedan fuera de alcance). Devuelve el pagador que ya hay si
 * `change` (un alta sin `id`, o la edición de `id`) lo dejaría con dos; null
 * si se puede. La BD lo garantiza también con un índice único parcial.
 */
export function payerConflict(
  live: readonly PayerCandidate[],
  change: { id?: string; isPayer: boolean },
): PayerCandidate | null {
  if (!change.isPayer) return null;
  return live.find((p) => p.isPayer && p.id !== change.id) ?? null;
}
