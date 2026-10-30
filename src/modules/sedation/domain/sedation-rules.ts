import type {
  AsaClass,
  SedationAgentKind,
  SedationDoseUnit,
  SedationGrade,
  SedationLevel,
  SedationRoute,
  SedationVitalsPhase,
} from '@prisma/client';
import type {
  SedationAssessmentField,
  SedationTemplate,
  SedationVitalField,
} from './sedation-template';

/**
 * Reglas de la hoja de sedación (DX-407). Funciones puras: las llama el
 * SERVIDOR al guardar cada parte (valoración, checklist, fármaco, toma,
 * egreso) con la plantilla de la hoja; la web solo enseña lo que devuelven.
 *
 * Versionado: `SEDATION_RULES_VERSION` va en cada hoja. Cambiar una regla, un
 * umbral o una dosis obliga a subir la versión.
 */
export const SEDATION_RULES_VERSION = 'SEDATION_RULES_V1';

/**
 * Reversores (AAPD, *Procedural Sedation Record*, 2024): naloxona 0,1 mg/kg
 * (máx. 2 mg) y flumazenil 0,01 mg/kg (máx. 0,2 mg).
 */
export const NALOXONE_MG_PER_KG = 0.1;
export const NALOXONE_MAX_MG = 2;
export const FLUMAZENIL_MG_PER_KG = 0.01;
export const FLUMAZENIL_MAX_MG = 0.2;

/** Mínimo de una justificación o interconsulta para que cuente. */
export const SEDATION_REASON_MIN = 10;

/** ASA desde la que hace falta interconsulta o justificación. */
const HIGH_ASA: readonly AsaClass[] = ['III', 'IV', 'V'];

const MINUTE_MS = 60_000;

/** Un problema de una parte de la hoja: código estable y texto para la web. */
export interface SedationProblem {
  code: string;
  message: string;
}

export interface ReversalDoses {
  naloxoneMg: number;
  flumazenilMg: number;
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function filled(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.trim().length > 0;
}

function longEnough(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.trim().length >= SEDATION_REASON_MIN;
}

/** IMC = kg / m², a un decimal. Sin peso o talla, null. */
export function bodyMassIndex(
  weightKg: number | null | undefined,
  heightCm: number | null | undefined,
): number | null {
  if (!weightKg || !heightCm) return null;
  const m = heightCm / 100;
  return round(weightKg / (m * m), 1);
}

/** Dosis de los reversores para ese peso, con sus topes. Sin peso, null. */
export function reversalDoses(
  weightKg: number | null | undefined,
): ReversalDoses | null {
  if (!weightKg) return null;
  return {
    naloxoneMg: round(
      Math.min(NALOXONE_MG_PER_KG * weightKg, NALOXONE_MAX_MG),
      2,
    ),
    flumazenilMg: round(
      Math.min(FLUMAZENIL_MG_PER_KG * weightKg, FLUMAZENIL_MAX_MG),
      3,
    ),
  };
}

// ---------------------------------------------------------------------------
// Valoración previa
// ---------------------------------------------------------------------------

export interface SedationAssessmentInput {
  grade: SedationGrade;
  asaClass?: AsaClass;
  asaEmergency: boolean;
  highAsaInterconsultation?: string;
  highAsaJustification?: string;
  fastingClearLiquidsHours?: number;
  fastingSolidsHours?: number;
  mallampati?: number;
  weightKg?: number;
  heightCm?: number;
  escortName?: string;
  escortRelationship?: string;
  consentConfirmed: boolean;
  consentId?: string;
}

const ASSESSMENT_MESSAGES: Record<SedationAssessmentField, string> = {
  ASA: 'Indica la clase ASA del paciente.',
  FASTING: 'Anota las horas de ayuno de líquidos claros y de sólidos.',
  MALLAMPATI: 'Anota la vía aérea (Mallampati I–IV).',
  WEIGHT: 'Anota el peso medido hoy en el sillón.',
  HEIGHT: 'Anota la talla para calcular el IMC.',
  ESCORT: 'Anota el acompañante adulto y su relación con el paciente.',
  CONSENT: 'Confirma que el consentimiento de sedación está firmado.',
};

function assessmentFieldMissing(
  field: SedationAssessmentField,
  input: SedationAssessmentInput,
): boolean {
  switch (field) {
    case 'ASA':
      return input.asaClass === undefined;
    case 'FASTING':
      return (
        input.fastingClearLiquidsHours === undefined ||
        input.fastingSolidsHours === undefined
      );
    case 'MALLAMPATI':
      return input.mallampati === undefined;
    case 'WEIGHT':
      return input.weightKg === undefined;
    case 'HEIGHT':
      return input.heightCm === undefined;
    case 'ESCORT':
      return !filled(input.escortName) || !filled(input.escortRelationship);
    case 'CONSENT':
      return !input.consentConfirmed;
  }
}

/** Lo que falta en la valoración según la plantilla, en orden de la hoja. */
export function assessmentProblems(
  input: SedationAssessmentInput,
  template: SedationTemplate,
): SedationProblem[] {
  const problems: SedationProblem[] = [];
  const order: SedationAssessmentField[] = [
    'ASA',
    'FASTING',
    'MALLAMPATI',
    'WEIGHT',
    'HEIGHT',
    'ESCORT',
    'CONSENT',
  ];
  for (const field of order) {
    if (
      template.requiredAssessment.includes(field) &&
      assessmentFieldMissing(field, input)
    ) {
      problems.push({ code: field, message: ASSESSMENT_MESSAGES[field] });
    }
    if (
      field === 'ASA' &&
      input.asaClass !== undefined &&
      HIGH_ASA.includes(input.asaClass) &&
      !longEnough(input.highAsaInterconsultation) &&
      !longEnough(input.highAsaJustification)
    ) {
      problems.push({
        code: 'HIGH_ASA_REASON',
        message: `Con ASA ${input.asaClass} registra la interconsulta médica o una justificación (mínimo ${SEDATION_REASON_MIN} caracteres) antes de sedar.`,
      });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Checklist previo
// ---------------------------------------------------------------------------

export interface SedationMark {
  code: string;
  checked: boolean;
}

export interface SedationChecklistItem {
  code: string;
  label: string;
  checked: boolean;
}

export function checklistProblems(
  marks: readonly SedationMark[],
  template: SedationTemplate,
): SedationProblem[] {
  const known = new Set(template.checklist.map((i) => i.code));
  if (marks.some((m) => !known.has(m.code))) {
    return [
      {
        code: 'UNKNOWN_ITEM',
        message: 'El checklist trae un ítem que la plantilla no tiene.',
      },
    ];
  }
  const checked = new Set(marks.filter((m) => m.checked).map((m) => m.code));
  return template.checklist
    .filter((i) => i.required && !checked.has(i.code))
    .map((i) => ({ code: i.code, message: `Falta marcar: ${i.label}.` }));
}

/** Copia de los ítems de la plantilla con la marca de cada uno. */
export function buildChecklistItems(
  marks: readonly SedationMark[],
  template: SedationTemplate,
): SedationChecklistItem[] {
  const checked = new Set(marks.filter((m) => m.checked).map((m) => m.code));
  return template.checklist.map((i) => ({
    code: i.code,
    label: i.label,
    checked: checked.has(i.code),
  }));
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

export interface SedationVitalsValues {
  spo2?: number;
  heartRate?: number;
  systolic?: number;
  diastolic?: number;
  respiratoryRate?: number;
  etco2?: number;
  sedationLevel?: SedationLevel;
}

const VITAL_MESSAGES: Record<SedationVitalField, string> = {
  SPO2: 'Anota la SpO₂.',
  HEART_RATE: 'Anota la frecuencia cardiaca.',
  BLOOD_PRESSURE: 'Anota la tensión arterial (sistólica y diastólica).',
  RESPIRATORY_RATE: 'Anota la frecuencia respiratoria.',
  ETCO2: 'Anota el CO₂ espirado.',
  SEDATION_LEVEL: 'Indica el nivel de sedación.',
};

function vitalMissing(
  field: SedationVitalField,
  v: SedationVitalsValues,
): boolean {
  switch (field) {
    case 'SPO2':
      return v.spo2 === undefined;
    case 'HEART_RATE':
      return v.heartRate === undefined;
    case 'BLOOD_PRESSURE':
      return v.systolic === undefined || v.diastolic === undefined;
    case 'RESPIRATORY_RATE':
      return v.respiratoryRate === undefined;
    case 'ETCO2':
      return v.etco2 === undefined;
    case 'SEDATION_LEVEL':
      return v.sedationLevel === undefined;
  }
}

export function vitalsProblems(
  values: SedationVitalsValues,
  template: SedationTemplate,
): SedationProblem[] {
  const order: SedationVitalField[] = [
    'SPO2',
    'HEART_RATE',
    'BLOOD_PRESSURE',
    'RESPIRATORY_RATE',
    'ETCO2',
    'SEDATION_LEVEL',
  ];
  const problems: SedationProblem[] = order
    .filter(
      (f) => template.requiredVitals.includes(f) && vitalMissing(f, values),
    )
    .map((f) => ({ code: f, message: VITAL_MESSAGES[f] }));
  const halfBp =
    (values.systolic === undefined) !== (values.diastolic === undefined);
  if (halfBp && !problems.some((p) => p.code === 'BLOOD_PRESSURE')) {
    problems.push({
      code: 'BLOOD_PRESSURE',
      message: VITAL_MESSAGES.BLOOD_PRESSURE,
    });
  }
  if (
    values.systolic !== undefined &&
    values.diastolic !== undefined &&
    values.diastolic >= values.systolic
  ) {
    problems.push({
      code: 'BLOOD_PRESSURE_ORDER',
      message: 'La diastólica tiene que ser menor que la sistólica.',
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Aviso de intervalo sin toma
// ---------------------------------------------------------------------------

export interface SedationTimeline {
  intervalMinutes: number;
  checklistDone: boolean;
  discharged: boolean;
  /** Hora de cada fármaco administrado. */
  agentTimes: readonly Date[];
  vitals: readonly { phase: SedationVitalsPhase; takenAt: Date }[];
}

export interface VitalsWatch {
  intervalMinutes: number;
  /** La sedación está en curso: checklist hecho, ha empezado y sin egreso. */
  active: boolean;
  /** Primer fármaco o primera toma intraoperatoria. */
  startedAt: Date | null;
  lastTakenAt: Date | null;
  /** Cuándo vence la próxima toma; null si no hay sedación en curso. */
  nextDueAt: Date | null;
  overdue: boolean;
  overdueMinutes: number;
  /** Huecos pasados entre tomas (desde el inicio) mayores que el intervalo. */
  missedIntervals: number;
}

/**
 * Vigilancia de las tomas: mientras la sedación está en curso, cada toma
 * tiene que llegar antes de que pase el intervalo desde la anterior (o desde
 * el inicio). `overdue` es el aviso «se pasó el intervalo sin toma».
 */
export function vitalsWatch(state: SedationTimeline, now: Date): VitalsWatch {
  const intervalMs = state.intervalMinutes * MINUTE_MS;
  const starts = [
    ...state.agentTimes.map((t) => t.getTime()),
    ...state.vitals
      .filter((v) => v.phase === 'INTRA')
      .map((v) => v.takenAt.getTime()),
  ];
  const startedMs = starts.length > 0 ? Math.min(...starts) : null;
  const allTaken = state.vitals.map((v) => v.takenAt.getTime());
  const lastTakenMs = allTaken.length > 0 ? Math.max(...allTaken) : null;
  const lastTakenAt = lastTakenMs === null ? null : new Date(lastTakenMs);

  let missedIntervals = 0;
  if (startedMs !== null) {
    const marks = [
      startedMs,
      ...allTaken.filter((t) => t >= startedMs).sort((a, b) => a - b),
    ];
    for (let i = 1; i < marks.length; i += 1) {
      if (marks[i] - marks[i - 1] > intervalMs) missedIntervals += 1;
    }
  }

  const active = state.checklistDone && !state.discharged && startedMs !== null;
  if (!active || startedMs === null) {
    return {
      intervalMinutes: state.intervalMinutes,
      active: false,
      startedAt: startedMs === null ? null : new Date(startedMs),
      lastTakenAt,
      nextDueAt: null,
      overdue: false,
      overdueMinutes: 0,
      missedIntervals,
    };
  }
  const anchor = Math.max(startedMs, lastTakenMs ?? startedMs);
  const nextDueMs = anchor + intervalMs;
  const late = now.getTime() - nextDueMs;
  return {
    intervalMinutes: state.intervalMinutes,
    active: true,
    startedAt: new Date(startedMs),
    lastTakenAt,
    nextDueAt: new Date(nextDueMs),
    overdue: late > 0,
    overdueMinutes: late > 0 ? Math.floor(late / MINUTE_MS) : 0,
    missedIntervals,
  };
}

// ---------------------------------------------------------------------------
// Fármacos
// ---------------------------------------------------------------------------

export interface SedationAgentInput {
  kind: SedationAgentKind;
  drugName?: string;
  dose?: number;
  doseUnit?: SedationDoseUnit;
  route?: SedationRoute;
  n2oPercent?: number;
  flowLpm?: number;
}

const ORAL_ROUTES: readonly SedationRoute[] = ['ORAL', 'SUBLINGUAL'];

export function agentProblems(input: SedationAgentInput): SedationProblem[] {
  const problems: SedationProblem[] = [];
  if (input.kind === 'NITROUS_OXIDE') {
    if (input.n2oPercent === undefined) {
      problems.push({
        code: 'N2O_PERCENT',
        message: 'Anota el % de óxido nitroso.',
      });
    }
    if (input.flowLpm === undefined) {
      problems.push({
        code: 'N2O_FLOW',
        message: 'Anota el flujo total en l/min.',
      });
    }
    if (
      input.drugName !== undefined ||
      input.dose !== undefined ||
      input.doseUnit !== undefined ||
      (input.route !== undefined && input.route !== 'INHALED')
    ) {
      problems.push({
        code: 'N2O_SHAPE',
        message:
          'El óxido nitroso se registra con % y flujo, inhalado y sin dosis.',
      });
    }
    return problems;
  }
  if (!filled(input.drugName)) {
    problems.push({ code: 'DRUG', message: 'Anota el fármaco.' });
  }
  if (input.dose === undefined || input.doseUnit === undefined) {
    problems.push({ code: 'DOSE', message: 'Anota la dosis y su unidad.' });
  }
  if (input.kind === 'OTHER' && input.route === undefined) {
    problems.push({ code: 'ROUTE', message: 'Indica la vía.' });
  }
  if (
    input.kind === 'ORAL' &&
    input.route !== undefined &&
    !ORAL_ROUTES.includes(input.route)
  ) {
    problems.push({
      code: 'ORAL_ROUTE',
      message: 'Un sedante oral va por vía oral o sublingual.',
    });
  }
  if (input.n2oPercent !== undefined || input.flowLpm !== undefined) {
    problems.push({
      code: 'AGENT_SHAPE',
      message: 'El % y el flujo son solo del óxido nitroso.',
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Egreso
// ---------------------------------------------------------------------------

export interface SedationCriterionMark {
  code: string;
  met: boolean;
}

export interface SedationDischargeCriterion {
  code: string;
  label: string;
  met: boolean;
}

export interface SedationDischargeInput {
  criteria: readonly SedationCriterionMark[];
  aldreteScore?: number;
  vitals: SedationVitalsValues;
  handedOverToName: string;
  handedOverToRelationship: string;
  instructionsDelivered: boolean;
  monitorId: string;
  sameMonitorJustification?: string;
}

export interface SedationDischargeContext {
  grade: SedationGrade;
  /** Quien firma el egreso. */
  operatorId: string;
  /** Último fármaco o toma registrados (null si no hay). */
  lastEventAt: Date | null;
  dischargedAt: Date;
}

export function dischargeProblems(
  input: SedationDischargeInput,
  template: SedationTemplate,
  ctx: SedationDischargeContext,
): SedationProblem[] {
  const problems: SedationProblem[] = [];
  const known = new Set(template.dischargeCriteria.map((c) => c.code));
  if (input.criteria.some((c) => !known.has(c.code))) {
    problems.push({
      code: 'UNKNOWN_CRITERION',
      message: 'El egreso trae un criterio que la plantilla no tiene.',
    });
  }
  const met = new Set(input.criteria.filter((c) => c.met).map((c) => c.code));
  const allMet = template.dischargeCriteria.every((c) => met.has(c.code));
  const aldreteOk =
    input.aldreteScore !== undefined &&
    input.aldreteScore >= template.aldreteMinimum;
  if (!allMet && !aldreteOk) {
    problems.push({
      code: 'DISCHARGE_CRITERIA',
      message: `Marca los ${template.dischargeCriteria.length} criterios de alta o anota un Aldrete modificado ≥ ${template.aldreteMinimum}.`,
    });
  }
  problems.push(...vitalsProblems(input.vitals, template));
  if (
    !filled(input.handedOverToName) ||
    !filled(input.handedOverToRelationship)
  ) {
    problems.push({
      code: 'HANDED_OVER_TO',
      message: 'Anota a quién se entrega el paciente y su relación.',
    });
  }
  if (!input.instructionsDelivered) {
    problems.push({
      code: 'INSTRUCTIONS',
      message: 'Confirma que se entregaron las indicaciones al acompañante.',
    });
  }
  if (
    ctx.lastEventAt !== null &&
    ctx.dischargedAt.getTime() < ctx.lastEventAt.getTime()
  ) {
    problems.push({
      code: 'DISCHARGED_AT_ORDER',
      message:
        'La hora de egreso no puede ser anterior a la última toma o fármaco.',
    });
  }
  if (
    ctx.grade === 'MODERATE' &&
    input.monitorId === ctx.operatorId &&
    !longEnough(input.sameMonitorJustification)
  ) {
    problems.push({
      code: 'SAME_MONITOR',
      message: `En sedación moderada, si quien monitoriza es el mismo operador, justifícalo (mínimo ${SEDATION_REASON_MIN} caracteres).`,
    });
  }
  return problems;
}

/** Copia de los criterios de la plantilla con si se cumplían. */
export function buildDischargeCriteria(
  marks: readonly SedationCriterionMark[],
  template: SedationTemplate,
): SedationDischargeCriterion[] {
  const met = new Set(marks.filter((m) => m.met).map((m) => m.code));
  return template.dischargeCriteria.map((c) => ({
    code: c.code,
    label: c.label,
    met: met.has(c.code),
  }));
}
