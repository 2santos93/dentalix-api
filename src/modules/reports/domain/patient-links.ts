/**
 * «Enlaces del paciente» (DX-424): qué enlaces que la clínica manda al
 * paciente se abren y se completan, por tipo y sede. Puro: lo prueban los
 * unit; el repositorio solo cuenta en la BD.
 *
 * Cohorte: los enlaces ENVIADOS en el período (por la fecha de envío, en la
 * zona de su sede). Abiertos, completados y «caducados sin abrir» son de esos
 * mismos enlaces, mirados hoy; por eso las tasas son sobre los enviados.
 */

/** Los enlaces que hoy llegan al paciente. */
export const PATIENT_LINK_TYPES = [
  'ANAMNESIS',
  'CONSENT_SIGNATURE',
  'BUDGET_SIGNATURE',
  'APPOINTMENT_CONFIRMATION',
  'POST_OP_INSTRUCTIONS',
] as const;

export type PatientLinkType = (typeof PATIENT_LINK_TYPES)[number];

/**
 * Qué señal guarda cada tipo. Sin señal, la columna sale `null` («—»), nunca
 * un cero inventado:
 *  - la confirmación de cita no registra la apertura (solo la respuesta), así
 *    que tampoco sabe si caducó sin abrirse;
 *  - las indicaciones postoperatorias no piden nada al paciente: abrirlas es
 *    todo el uso, no hay «completado».
 */
export const PATIENT_LINK_SIGNALS: Record<
  PatientLinkType,
  { opened: boolean; completed: boolean }
> = {
  ANAMNESIS: { opened: true, completed: true },
  CONSENT_SIGNATURE: { opened: true, completed: true },
  BUDGET_SIGNATURE: { opened: true, completed: true },
  APPOINTMENT_CONFIRMATION: { opened: false, completed: true },
  POST_OP_INSTRUCTIONS: { opened: true, completed: false },
};

/** Lo que cuenta la BD de un tipo (en una sede, o en todas). */
export interface PatientLinkCounts {
  sent: number;
  opened: number;
  completed: number;
  expiredUnopened: number;
  /** Mediana de envío → completado, en segundos; null sin completados. */
  medianSecondsToComplete: number | null;
}

export interface PatientLinkMetrics {
  linkType: PatientLinkType;
  tracksOpened: boolean;
  tracksCompleted: boolean;
  sent: number;
  opened: number | null;
  completed: number | null;
  expiredUnopened: number | null;
  /** % sobre los enviados, con 1 decimal; null sin envíos o sin señal. */
  openedRate: number | null;
  completedRate: number | null;
  expiredUnopenedRate: number | null;
  /** Horas (1 decimal) de envío a completado, mediana; null sin datos. */
  medianHoursToComplete: number | null;
}

export const EMPTY_PATIENT_LINK_COUNTS: PatientLinkCounts = {
  sent: 0,
  opened: 0,
  completed: 0,
  expiredUnopened: 0,
  medianSecondsToComplete: null,
};

/** `part` sobre `sent` en %, con 1 decimal; null sin envíos. */
export function percentOfSent(part: number, sent: number): number | null {
  if (sent <= 0) return null;
  return Math.round((part * 1000) / sent) / 10;
}

/** Segundos → horas con 1 decimal. */
export function hoursOneDecimal(seconds: number | null): number | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  return Math.round(seconds / 360) / 10;
}

/** Las métricas de un tipo a partir de sus cuentas. */
export function patientLinkMetrics(
  linkType: PatientLinkType,
  counts: PatientLinkCounts,
): PatientLinkMetrics {
  const signals = PATIENT_LINK_SIGNALS[linkType];
  const opened = signals.opened ? counts.opened : null;
  const completed = signals.completed ? counts.completed : null;
  // «Sin abrir» necesita saber si se abrió.
  const expiredUnopened = signals.opened ? counts.expiredUnopened : null;
  const rate = (n: number | null) =>
    n === null ? null : percentOfSent(n, counts.sent);
  return {
    linkType,
    tracksOpened: signals.opened,
    tracksCompleted: signals.completed,
    sent: counts.sent,
    opened,
    completed,
    expiredUnopened,
    openedRate: rate(opened),
    completedRate: rate(completed),
    expiredUnopenedRate: rate(expiredUnopened),
    medianHoursToComplete:
      signals.completed && counts.completed > 0
        ? hoursOneDecimal(counts.medianSecondsToComplete)
        : null,
  };
}

/** Una fila por tipo, en el orden fijo de `PATIENT_LINK_TYPES`. */
export function patientLinkRows(
  counts: ReadonlyMap<PatientLinkType, PatientLinkCounts>,
): PatientLinkMetrics[] {
  return PATIENT_LINK_TYPES.map((type) =>
    patientLinkMetrics(type, counts.get(type) ?? EMPTY_PATIENT_LINK_COUNTS),
  );
}
