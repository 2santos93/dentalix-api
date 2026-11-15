/**
 * DX-020: tarjeta «Pon en marcha tu clínica» del panel del ADMIN.
 *
 * Nada se marca a mano: cada paso sale de los datos que ya existen. Los
 * `facts` los calcula el repositorio en UNA consulta (EXISTS por paso); aquí
 * solo se ordenan y se resumen, para poder probarlo sin base de datos.
 *
 * Criterio de cada paso (se repite en el README de la API y en el informe):
 *  - BUSINESS_HOURS: alguna sede viva tiene un horario guardado por la
 *    clínica, es decir, sus tramos se reemplazaron al menos una vez (hay
 *    tramos retirados). El horario por defecto que siembran el alta y la
 *    sede nueva no cuenta: nadie lo ha mirado todavía.
 *  - APPOINTMENT_TYPES: algún tipo de cita vivo y activo.
 *  - CATALOG_PRICES: algún procedimiento vivo del catálogo con precio, o algún
 *    precio en una lista de precios viva. La semilla nace SIN precios, así que
 *    cualquier precio es de la clínica.
 *  - STAFF: alguna invitación no revocada (pendiente, aceptada o caducada) o
 *    algún miembro vivo además del que creó la clínica (≥ 2 membresías).
 *  - FIRST_APPOINTMENT: alguna cita viva, en cualquier estado.
 *  - PATIENT_IMPORT (opcional, no cuenta para «listo»): algún lote de
 *    importación de pacientes terminado (COMPLETED; uno deshecho no cuenta).
 */
export const ONBOARDING_REQUIRED_STEPS = [
  'BUSINESS_HOURS',
  'APPOINTMENT_TYPES',
  'CATALOG_PRICES',
  'STAFF',
  'FIRST_APPOINTMENT',
] as const;

export const ONBOARDING_OPTIONAL_STEPS = ['PATIENT_IMPORT'] as const;

export type OnboardingRequiredStep = (typeof ONBOARDING_REQUIRED_STEPS)[number];
export type OnboardingOptionalStep = (typeof ONBOARDING_OPTIONAL_STEPS)[number];
export type OnboardingStepKey = OnboardingRequiredStep | OnboardingOptionalStep;

export const ONBOARDING_STEP_KEYS: readonly OnboardingStepKey[] = [
  ...ONBOARDING_REQUIRED_STEPS,
  ...ONBOARDING_OPTIONAL_STEPS,
];

/** Lo que el repositorio averigua: un booleano por paso y el descarte. */
export interface OnboardingFacts {
  dismissedAt: Date | null;
  done: Record<OnboardingStepKey, boolean>;
}

export interface OnboardingStep {
  key: OnboardingStepKey;
  done: boolean;
  optional: boolean;
}

export interface OnboardingStatus {
  /** NULL = la tarjeta se muestra. */
  dismissedAt: Date | null;
  /** Los 5 obligatorios en orden, y después el opcional. */
  steps: OnboardingStep[];
  /** Obligatorios hechos (el opcional no cuenta). */
  completedCount: number;
  requiredCount: number;
  /** Los 5 obligatorios hechos. */
  allDone: boolean;
}

export function computeOnboardingStatus(
  facts: OnboardingFacts,
): OnboardingStatus {
  const required = ONBOARDING_REQUIRED_STEPS.map((key): OnboardingStep => ({
    key,
    done: facts.done[key] === true,
    optional: false,
  }));
  const optional = ONBOARDING_OPTIONAL_STEPS.map((key): OnboardingStep => ({
    key,
    done: facts.done[key] === true,
    optional: true,
  }));
  const completedCount = required.filter((s) => s.done).length;
  return {
    dismissedAt: facts.dismissedAt,
    steps: [...required, ...optional],
    completedCount,
    requiredCount: required.length,
    allDone: completedCount === required.length,
  };
}
