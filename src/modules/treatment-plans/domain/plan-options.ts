import {
  TreatmentPlanRejectionReason,
  TreatmentPlanStatus,
} from '@prisma/client';

/** Tope de la etiqueta de una opción (CHECK `treatment_plans_option_label_check`). */
export const OPTION_LABEL_MAX = 60;
/** Tope de la nota de un rechazo (CHECK `treatment_plans_rejection_note_check`). */
export const REJECTION_NOTE_MAX = 500;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Etiqueta por defecto de la opción número `index` (0 → «Opción A»). */
export function defaultOptionLabel(index: number): string {
  return index < LETTERS.length
    ? `Opción ${LETTERS[index]}`
    : `Opción ${index + 1}`;
}

/**
 * Etiqueta por defecto de la opción NUEVA de un grupo, sin repetir letra: la
 * siguiente a la mayor «Opción X» usada (con «Opción A» y «Opción C», la D).
 * Si nadie lleva letra, la que toca por número de opciones (`labels` incluye
 * la del plan de origen ya resuelta).
 */
export function nextOptionLabel(labels: readonly (string | null)[]): string {
  const used = new Set(
    labels.filter((l): l is string => l !== null).map((l) => l.trim()),
  );
  const lettered = labels
    .map((l) => /^Opción ([A-Z])\b/.exec(l?.trim() ?? '')?.[1])
    .filter((letter): letter is string => letter !== undefined)
    .map((letter) => LETTERS.indexOf(letter));
  let index = lettered.length > 0 ? Math.max(...lettered) + 1 : labels.length;
  while (used.has(defaultOptionLabel(index))) index++;
  return defaultOptionLabel(index);
}

/** La etiqueta tal como se guarda: sin espacios en los bordes; vacía = null. */
export function normalizeOptionLabel(
  label: string | null | undefined,
): string | null {
  const trimmed = label?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

interface OptionSibling {
  id: string;
  status: TreatmentPlanStatus;
}

/**
 * Aceptar una opción rechaza en la MISMA transacción a sus hermanas que siguen
 * abiertas (borrador o presentadas), con el motivo OTHER_OPTION_ACCEPTED, como
 * hace Centaur. Las ya rechazadas o canceladas no se tocan. Una hermana ya
 * aceptada o completada es un conflicto: un grupo tiene como mucho una opción
 * elegida.
 */
export function optionSiblingsToReject(siblings: readonly OptionSibling[]): {
  reject: string[];
  conflict: boolean;
} {
  return {
    reject: siblings
      .filter(
        (s) =>
          s.status === TreatmentPlanStatus.DRAFT ||
          s.status === TreatmentPlanStatus.PRESENTED,
      )
      .map((s) => s.id),
    conflict: hasClosedOption(siblings),
  };
}

/** ¿El grupo ya tiene una opción elegida (aceptada o completada)? */
export function hasClosedOption(
  members: readonly { status: TreatmentPlanStatus }[],
): boolean {
  return members.some(
    (m) =>
      m.status === TreatmentPlanStatus.ACCEPTED ||
      m.status === TreatmentPlanStatus.COMPLETED,
  );
}

/**
 * `null` si el rechazo es válido; si no, el motivo en español (400). El
 * personal elige del catálogo salvo «otra opción aceptada», que es del sistema;
 * «Otro» exige explicarlo en la nota.
 */
export function rejectionInputError(
  reason: TreatmentPlanRejectionReason,
  note: string | null | undefined,
): string | null {
  if (reason === TreatmentPlanRejectionReason.OTHER_OPTION_ACCEPTED) {
    return '«Aceptó otra opción» lo registra el sistema al aceptar otra opción del grupo.';
  }
  const trimmed = note?.trim() ?? '';
  if (trimmed.length > REJECTION_NOTE_MAX) {
    return `La nota del rechazo admite hasta ${REJECTION_NOTE_MAX} caracteres.`;
  }
  if (reason === TreatmentPlanRejectionReason.OTHER && trimmed === '') {
    return 'Con el motivo «Otro» describe en la nota por qué lo rechazó.';
  }
  return null;
}

/** Días completos transcurridos desde `from` hasta `now`. */
export function daysSince(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY_MS));
}

/**
 * `null` si el plan se puede marcar rechazado; si no, el motivo en español
 * (409). Un plan con procedimientos realizados o con abonos vivos ya se está
 * cobrando: rechazarlo lo sacaría del saldo con dinero o trabajo de por medio.
 */
export function rejectionBlocker(facts: {
  hasDoneItems: boolean;
  hasLivePayments: boolean;
}): string | null {
  if (facts.hasDoneItems) {
    return 'El plan tiene procedimientos realizados: no se puede marcar como rechazado.';
  }
  if (facts.hasLivePayments) {
    return 'El plan tiene abonos registrados: no se puede marcar como rechazado. Anula los abonos o cancela el plan.';
  }
  return null;
}

/** 409 al aceptar una opción cuya hermana abierta ya tiene abonos o trabajo hecho. */
export function siblingRejectionBlockedMessage(label: string | null): string {
  const name = label ? `«${label}»` : 'otra opción del grupo';
  return `La opción ${name} tiene abonos o procedimientos realizados: no se puede rechazar al aceptar esta. Revísala antes de aceptar.`;
}
