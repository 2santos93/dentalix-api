/*
 * «Embudo de presupuestos» (DX-558): de los presupuestos PRESENTADOS en un
 * período, cuántos se aceptaron, se agendaron, se realizaron y se cobraron
 * hasta hoy. ÚNICA definición de cada paso: la API la publica tal cual (la web
 * pinta «Cómo se calcula» con ella) y el CSV escribe la misma.
 *
 * Puro: lo prueban los unit; el repositorio solo cuenta y suma en la BD.
 *
 * Unidad: la PRESENTACIÓN, un grupo de opciones A/B (DX-040; un plan suelto es
 * su propio grupo) con sus planes raíz presentados. Cada opción arrastra la
 * cadena de sus pendientes de una aceptación parcial (DX-417): lo presentado
 * es la suma de toda la cadena, y un pendiente nunca es una presentación.
 *
 * Importes en la moneda del CATÁLOGO: un ítem de un plan en otra moneda se
 * convierte con la tasa congelada en el propio ítem (DX-513-bis/ter); sin
 * ella, su presentación queda fuera de los importes (no de los números).
 */

import { round2 } from '../../../shared/money/money';

/** Los pasos del embudo, en orden. */
export const QUOTE_FUNNEL_STEPS = [
  'PRESENTED',
  'ACCEPTED',
  'SCHEDULED',
  'DONE',
  'COLLECTED',
] as const;
export type QuoteFunnelStep = (typeof QUOTE_FUNNEL_STEPS)[number];

/** El estado de lo que NO se aceptó (hoy). */
export const QUOTE_FUNNEL_OUTCOMES = [
  'PENDING',
  'REJECTED',
  'CANCELLED',
] as const;
export type QuoteFunnelOutcome = (typeof QUOTE_FUNNEL_OUTCOMES)[number];

/** El desenlace de una presentación: aceptada o uno de los de arriba. */
export type QuoteFunnelPresentationOutcome = 'ACCEPTED' | QuoteFunnelOutcome;

/** Lo que se puede listar en el detalle: un paso o un desenlace. */
export const QUOTE_FUNNEL_DETAIL_STEPS = [
  ...QUOTE_FUNNEL_STEPS,
  ...QUOTE_FUNNEL_OUTCOMES,
] as const;
export type QuoteFunnelDetailStep = (typeof QUOTE_FUNNEL_DETAIL_STEPS)[number];

/**
 * Motivos de rechazo que cuentan. `OTHER_OPTION_ACCEPTED` lo pone el sistema a
 * las opciones hermanas al aceptar una (DX-040): no es un rechazo del grupo.
 */
export const QUOTE_FUNNEL_REJECTION_REASONS = [
  'PRICE',
  'FEAR',
  'SECOND_OPINION',
  'OTHER',
] as const;
export type QuoteFunnelRejectionReason =
  (typeof QUOTE_FUNNEL_REJECTION_REASONS)[number];

/** Avisos de la respuesta. */
export const QUOTE_FUNNEL_WARNINGS = [
  'NO_CATALOG_CURRENCY',
  'WITHOUT_RATE',
] as const;
export type QuoteFunnelWarning = (typeof QUOTE_FUNNEL_WARNINGS)[number];

export const QUOTE_FUNNEL_DEFINITION_KEYS = [
  ...QUOTE_FUNNEL_STEPS,
  'ACCEPTANCE_RATE',
  'MEDIAN_DAYS_TO_ACCEPT',
  'OUTCOMES',
  'REJECTION_REASONS',
  'PROFESSIONAL',
  'CURRENCY',
] as const;
export type QuoteFunnelDefinitionKey =
  (typeof QUOTE_FUNNEL_DEFINITION_KEYS)[number];

export interface QuoteFunnelDefinition {
  key: QuoteFunnelDefinitionKey;
  /** Nombre corto: el de la barra, la columna o el bloque. */
  label: string;
  /** Las reglas, una por línea («Cómo se calcula»). */
  howItIsCalculated: string[];
}

/** Nombre de la fila de las presentaciones sin profesional (DX-305). */
export const UNATTRIBUTED_PROFESSIONAL_NAME = 'Sin atribuir';

export const QUOTE_FUNNEL_DEFINITIONS: Readonly<
  Record<QuoteFunnelDefinitionKey, QuoteFunnelDefinition>
> = {
  PRESENTED: {
    key: 'PRESENTED',
    label: 'Presentados',
    howItIsCalculated: [
      'Una presentación es un presupuesto presentado al paciente en el período. Las opciones A/B de un mismo presupuesto cuentan una sola vez.',
      'Su fecha es la de la primera presentación, en el día civil de la sede donde se presentó.',
      'Importe: el de la opción más amplia (la de mayor total). Si el paciente elige una opción más barata, la tasa por importe lo refleja.',
      'Una aceptación parcial no crea otra presentación: lo que quedó pendiente sigue siendo parte del presupuesto original.',
      'Los presupuestos que se aceptaron sin presentarse antes no entran en el embudo.',
    ],
  },
  ACCEPTED: {
    key: 'ACCEPTED',
    label: 'Aceptados',
    howItIsCalculated: [
      'Presentaciones con alguna opción que el paciente aceptó, en cualquier fecha hasta hoy, aunque después se completara o se cancelara: un aceptado y luego cancelado sigue contando aquí, y la caída se ve en los pasos siguientes.',
      'Importe: lo aceptado (los procedimientos vivos de las opciones aceptadas). Una aceptación parcial cuenta entera por número y solo lo aceptado por importe; si lo pendiente se acepta después, se suma entonces.',
    ],
  },
  SCHEDULED: {
    key: 'SCHEDULED',
    label: 'Agendados',
    howItIsCalculated: [
      'Presentaciones aceptadas con algún procedimiento aceptado en una cita (en cualquier estado, mientras no se haya borrado) o ya realizado sin cita.',
      'Importe: el de esos procedimientos.',
    ],
  },
  DONE: {
    key: 'DONE',
    label: 'Realizados',
    howItIsCalculated: [
      'Presentaciones aceptadas con algún procedimiento marcado como realizado.',
      'Importe: el de los procedimientos realizados.',
    ],
  },
  COLLECTED: {
    key: 'COLLECTED',
    label: 'Cobrados',
    howItIsCalculated: [
      'Presentaciones aceptadas con algún abono imputado a sus procedimientos aceptados.',
      'Importe: lo imputado a esos procedimientos (no los abonos a cuenta sin imputar).',
    ],
  },
  ACCEPTANCE_RATE: {
    key: 'ACCEPTANCE_RATE',
    label: 'Tasa de aceptación',
    howItIsCalculated: [
      'Por número: aceptados ÷ presentados. Por importe: importe aceptado ÷ importe presentado.',
      'Cada paso muestra también su porcentaje sobre los presentados. Sin presentados no hay tasa («—»).',
    ],
  },
  MEDIAN_DAYS_TO_ACCEPT: {
    key: 'MEDIAN_DAYS_TO_ACCEPT',
    label: 'Días hasta aceptar (mediana)',
    howItIsCalculated: [
      'Días desde la presentación hasta la primera aceptación, en las presentaciones aceptadas. La mediana: la mitad tardó menos y la otra mitad más.',
      'La de cada profesional se calcula con sus presentaciones; la del total, con todas (no es la media de las medianas).',
    ],
  },
  OUTCOMES: {
    key: 'OUTCOMES',
    label: 'Lo no aceptado',
    howItIsCalculated: [
      'Pendientes: alguna opción sigue presentada, esperando respuesta.',
      'Rechazados: ninguna opción se aceptó, todas se rechazaron o se cancelaron, y al menos una la rechazó el paciente.',
      'Cancelados: el resto (la clínica las canceló sin que se aceptaran).',
    ],
  },
  REJECTION_REASONS: {
    key: 'REJECTION_REASONS',
    label: 'Motivos de rechazo',
    howItIsCalculated: [
      'De cada presentación rechazada, el motivo de la opción rechazada más reciente, ordenados por número y luego por importe.',
      '«Se aceptó otra opción» no es un rechazo: esa presentación cuenta como aceptada.',
    ],
  },
  PROFESSIONAL: {
    key: 'PROFESSIONAL',
    label: 'Profesional que lo elaboró',
    howItIsCalculated: [
      'Quien creó el presupuesto (el de la primera opción presentada). Si no consta o ya no es miembro de la clínica, va a «Sin atribuir».',
    ],
  },
  CURRENCY: {
    key: 'CURRENCY',
    label: 'Moneda',
    howItIsCalculated: [
      'Los importes son precio − descuento, en la moneda del catálogo de la clínica.',
      'Un presupuesto en otra moneda se convierte con la tasa guardada en cada procedimiento al crearlo; si alguno no la tiene, esa presentación cuenta en los números pero queda fuera de los importes (se avisa).',
    ],
  },
};

/** Las definiciones en el orden de publicación. */
export const QUOTE_FUNNEL_DEFINITION_LIST: readonly QuoteFunnelDefinition[] =
  QUOTE_FUNNEL_DEFINITION_KEYS.map((key) => QUOTE_FUNNEL_DEFINITIONS[key]);

/** Tasa congelada en un ítem: unidades por 1 USD (DX-513-ter). */
export interface ItemRate {
  /** Unidades de la moneda del CATÁLOGO por 1 USD (`referenceRateFrom`). */
  fromPerBase: number;
  /** Unidades de la moneda del PLAN por 1 USD (`referenceRateTo`). */
  toPerBase: number;
}

/**
 * Un importe en la moneda del plan, pasado a la del catálogo con la tasa del
 * ítem. La tasa es catálogo → plan (`× toPerBase ÷ fromPerBase`); esta es su
 * inversa, SIN redondear: se redondea al final de cada suma (`round2`). La
 * consulta SQL hace exactamente esta cuenta.
 */
export function planToCatalogAmount(amount: number, rate: ItemRate): number {
  return (amount * rate.fromPerBase) / rate.toPerBase;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** `part` sobre `whole` en %, con 1 decimal; null sin base (o sin datos). */
export function percentOf(
  part: number | null,
  whole: number | null,
): number | null {
  if (part === null || whole === null || whole <= 0) return null;
  return round1((part / whole) * 100);
}

/** Segundos → días con 1 decimal; null sin datos. */
export function secondsToDays(seconds: number | null): number | null {
  return seconds === null ? null : round1(seconds / 86_400);
}

/** Un importe sumado por la BD, a 2 decimales; null si no hay importes. */
export function amountOf(value: number | null): number | null {
  return value === null ? null : round2(value);
}

/** Número e importe de un paso o de un desenlace. */
export interface CountAmount {
  count: number;
  amount: number | null;
}

/**
 * Lo que cuenta la BD de un conjunto de presentaciones (las de un
 * profesional, o todas). Los importes son de las presentaciones CON tasa (o en
 * la moneda del catálogo), en la moneda del catálogo y sin redondear.
 */
export interface QuoteFunnelSums {
  presented: number;
  presentedAmount: number;
  accepted: number;
  acceptedAmount: number;
  scheduled: number;
  scheduledAmount: number;
  done: number;
  doneAmount: number;
  collected: number;
  collectedAmount: number;
  pending: number;
  pendingAmount: number;
  rejected: number;
  rejectedAmount: number;
  cancelled: number;
  cancelledAmount: number;
  /** Presentaciones fuera de los importes por falta de tasa. */
  withoutRate: number;
  /** Mediana presentación → primera aceptación, en segundos. */
  medianSecondsToAccept: number | null;
}

export const EMPTY_QUOTE_FUNNEL_SUMS: QuoteFunnelSums = {
  presented: 0,
  presentedAmount: 0,
  accepted: 0,
  acceptedAmount: 0,
  scheduled: 0,
  scheduledAmount: 0,
  done: 0,
  doneAmount: 0,
  collected: 0,
  collectedAmount: 0,
  pending: 0,
  pendingAmount: 0,
  rejected: 0,
  rejectedAmount: 0,
  cancelled: 0,
  cancelledAmount: 0,
  withoutRate: 0,
  medianSecondsToAccept: null,
};

export interface QuoteFunnelStepView {
  key: QuoteFunnelStep;
  count: number;
  amount: number | null;
  /** count ÷ presentados, en % (1 decimal); null sin presentados. */
  rateOfPresented: number | null;
  /** importe ÷ importe presentado, en % (1 decimal); null sin importes. */
  amountRateOfPresented: number | null;
}

export interface AcceptanceRate {
  byCount: number | null;
  byAmount: number | null;
}

export interface QuoteFunnelView {
  steps: QuoteFunnelStepView[];
  acceptanceRate: AcceptanceRate;
  medianDaysToAccept: number | null;
  outcomes: Record<'pending' | 'rejected' | 'cancelled', CountAmount>;
  withoutRate: { presentations: number };
}

const STEP_FIELDS: Record<
  QuoteFunnelStep,
  { count: keyof QuoteFunnelSums; amount: keyof QuoteFunnelSums }
> = {
  PRESENTED: { count: 'presented', amount: 'presentedAmount' },
  ACCEPTED: { count: 'accepted', amount: 'acceptedAmount' },
  SCHEDULED: { count: 'scheduled', amount: 'scheduledAmount' },
  DONE: { count: 'done', amount: 'doneAmount' },
  COLLECTED: { count: 'collected', amount: 'collectedAmount' },
};

/**
 * Los pasos, tasas, mediana y desenlaces de unas sumas. Con
 * `withAmounts = false` (sin moneda de catálogo) todos los importes y la tasa
 * por importe salen null; los números siguen.
 */
export function buildQuoteFunnel(
  sums: QuoteFunnelSums,
  withAmounts: boolean,
): QuoteFunnelView {
  const money = (value: number): number | null =>
    withAmounts ? amountOf(value) : null;
  const presentedAmount = money(sums.presentedAmount);
  const steps = QUOTE_FUNNEL_STEPS.map((key): QuoteFunnelStepView => {
    const fields = STEP_FIELDS[key];
    const count = sums[fields.count] as number;
    const amount = money(sums[fields.amount] as number);
    return {
      key,
      count,
      amount,
      rateOfPresented: percentOf(count, sums.presented),
      amountRateOfPresented: percentOf(amount, presentedAmount),
    };
  });
  const accepted = steps[1];
  return {
    steps,
    acceptanceRate: {
      byCount: accepted.rateOfPresented,
      byAmount: accepted.amountRateOfPresented,
    },
    medianDaysToAccept: secondsToDays(sums.medianSecondsToAccept),
    outcomes: {
      pending: { count: sums.pending, amount: money(sums.pendingAmount) },
      rejected: { count: sums.rejected, amount: money(sums.rejectedAmount) },
      cancelled: {
        count: sums.cancelled,
        amount: money(sums.cancelledAmount),
      },
    },
    withoutRate: { presentations: withAmounts ? sums.withoutRate : 0 },
  };
}

/** Un motivo de rechazo tal como lo cuenta la BD. */
export interface RejectionReasonSums {
  reason: QuoteFunnelRejectionReason;
  count: number;
  amount: number;
}

export interface RejectionReasonView {
  reason: QuoteFunnelRejectionReason;
  count: number;
  amount: number | null;
}

/** Los motivos, por número y luego por importe (desc); empate, por catálogo. */
export function sortRejectionReasons(
  rows: readonly RejectionReasonSums[],
  withAmounts: boolean,
): RejectionReasonView[] {
  return rows
    .filter((r) => r.count > 0)
    .map((r) => ({ ...r, amount: round2(r.amount) }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.amount - a.amount ||
        QUOTE_FUNNEL_REJECTION_REASONS.indexOf(a.reason) -
          QUOTE_FUNNEL_REJECTION_REASONS.indexOf(b.reason),
    )
    .map((r) => ({ ...r, amount: withAmounts ? r.amount : null }));
}

/** Los avisos de la respuesta. */
export function quoteFunnelWarnings(
  currency: string | null,
  withoutRate: number,
): QuoteFunnelWarning[] {
  if (currency === null) return ['NO_CATALOG_CURRENCY'];
  return withoutRate > 0 ? ['WITHOUT_RATE'] : [];
}
